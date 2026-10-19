/**
 * Transport-agnostic operator chat + alert-workflow hub.
 *
 * The Node server drives it with real WebSocket connections; in demo mode the
 * Web Worker drives it with one local connection, the simulated operator and
 * any peer tabs relayed over BroadcastChannel. Because message ids are the
 * sender's clientId and timestamps come from the sender (clamped), every
 * replica that sees the same client messages converges on the same state.
 */
import {
  GENERAL_ROOM,
  MAX_NAME,
  PROTOCOL_VERSION,
  isRoomId,
  sanitizeText,
  type AlertRef,
  type ChatWireMessage,
  type ClientMessage,
  type Operator,
  type OperatorPresence,
  type PresenceEvent,
  type ServerEvent,
} from './protocol';

export const HUMAN_OPERATORS: readonly Operator[] = [
  { id: 'op-a', name: 'Operator A' },
  { id: 'op-b', name: 'Operator B' },
];
export const SIM_OPERATOR: Operator = { id: 'op-sim', name: 'Layla (sim)' };

export type HubTarget = { to: 'conn'; id: string } | { to: 'all' } | { to: 'except'; id: string };

export interface ChatHubOptions {
  now: () => number;
  emit: (target: HubTarget, ev: ServerEvent) => void;
  maxPerRoom?: number;
  maxRooms?: number;
}

interface Conn {
  id: string;
  operator?: Operator;
  status: 'online' | 'away';
  simulated: boolean;
}

export interface WorkflowState {
  assignee?: string;
  ackedBy?: string;
}

const CLOCK_SKEW_MS = 5_000;

export class ChatHub {
  private readonly conns = new Map<string, Conn>();
  /** Map insertion order doubles as LRU order (rooms are re-inserted when touched). */
  private readonly rooms = new Map<string, ChatWireMessage[]>();
  private readonly workflow = new Map<string, WorkflowState>();
  /** Operators seen at least once, so we can report them as offline. */
  private readonly known = new Map<string, Operator>();
  private readonly maxPerRoom: number;
  private readonly maxRooms: number;

  constructor(private readonly opts: ChatHubOptions) {
    this.maxPerRoom = opts.maxPerRoom ?? 200;
    this.maxRooms = opts.maxRooms ?? 64;
    this.rooms.set(GENERAL_ROOM, []);
  }

  connect(connId: string, simulated = false): void {
    this.conns.set(connId, { id: connId, status: 'online', simulated });
  }

  disconnect(connId: string): void {
    const conn = this.conns.get(connId);
    if (!conn) return;
    this.conns.delete(connId);
    if (conn.operator) this.broadcastPresence();
  }

  connectionIds(): string[] {
    return [...this.conns.keys()];
  }

  isConnected(connId: string): boolean {
    return this.conns.has(connId);
  }

  operatorOf(connId: string): Operator | undefined {
    return this.conns.get(connId)?.operator;
  }

  handle(connId: string, msg: ClientMessage): void {
    const conn = this.conns.get(connId);
    if (!conn) return;
    const now = this.now();
    if (msg.type === 'join') {
      conn.operator = this.resolveOperator(connId, msg.operator, msg.auto);
      conn.status = 'online';
      this.known.set(conn.operator.id, conn.operator);
      this.emit({ to: 'conn', id: connId }, { v: PROTOCOL_VERSION, type: 'welcome', ts: now, operator: conn.operator });
      this.broadcastPresence();
      return;
    }
    const op = conn.operator;
    if (!op) return; // must join first
    switch (msg.type) {
      case 'presence':
        if (conn.status !== msg.status) {
          conn.status = msg.status;
          this.broadcastPresence();
        }
        return;
      case 'chat:send': {
        const text = sanitizeText(msg.text);
        if (!text || !isRoomId(msg.room)) return;
        const list = this.touchRoom(msg.room);
        const dup = list.find((m) => m.id === msg.clientId);
        if (dup) {
          // Idempotent resend after reconnect: just re-acknowledge.
          this.emit({ to: 'conn', id: connId }, { v: PROTOCOL_VERSION, type: 'chat:message', ts: now, message: dup });
          return;
        }
        const ts = Math.abs(msg.clientTs - now) <= CLOCK_SKEW_MS ? msg.clientTs : now;
        const message: ChatWireMessage = {
          id: msg.clientId,
          room: msg.room,
          from: op.id,
          fromName: op.name,
          text,
          ts,
          deliveredTo: [],
          readBy: [],
        };
        insertSorted(list, message);
        if (list.length > this.maxPerRoom) list.splice(0, list.length - this.maxPerRoom);
        this.emit({ to: 'all' }, { v: PROTOCOL_VERSION, type: 'chat:message', ts: now, message });
        return;
      }
      case 'chat:typing':
        this.emit({ to: 'except', id: connId }, { v: PROTOCOL_VERSION, type: 'chat:typing', ts: now, room: msg.room, from: op.id, typing: msg.typing });
        return;
      case 'chat:receipt': {
        const list = this.rooms.get(msg.room);
        if (list) {
          for (const m of list) {
            if (m.ts > msg.upTo || m.from === op.id) continue;
            if (!m.deliveredTo.includes(op.id)) m.deliveredTo.push(op.id);
            if (msg.kind === 'read' && !m.readBy.includes(op.id)) m.readBy.push(op.id);
          }
        }
        this.emit({ to: 'except', id: connId }, { v: PROTOCOL_VERSION, type: 'chat:receipt', ts: now, room: msg.room, by: op.id, kind: msg.kind, upTo: msg.upTo });
        return;
      }
      case 'alert:assign':
        this.setWorkflow(msg.alert, { assignee: msg.to });
        this.emit({ to: 'all' }, { v: PROTOCOL_VERSION, type: 'alert:assigned', ts: now, alert: msg.alert, to: msg.to, by: op.id });
        return;
      case 'alert:ack':
        this.setWorkflow(msg.alert, { ackedBy: op.id });
        this.emit({ to: 'all' }, { v: PROTOCOL_VERSION, type: 'alert:acked', ts: now, alert: msg.alert, by: op.id });
        return;
      case 'ping':
        return;
    }
  }

  /** Messages strictly older than `before` (newest `limit`), oldest first. */
  history(room: string, before = Infinity, limit = 30): { messages: ChatWireMessage[]; hasMore: boolean } {
    const list = this.rooms.get(room) ?? [];
    const older = list.filter((m) => m.ts < before);
    const n = Math.max(1, Math.min(100, Math.floor(limit)));
    return { messages: older.slice(-n), hasMore: older.length > n };
  }

  roomIds(): string[] {
    return [...this.rooms.keys()];
  }

  workflowOf(alertId: string): WorkflowState | undefined {
    return this.workflow.get(alertId);
  }

  presence(): OperatorPresence[] {
    const byId = new Map<string, OperatorPresence>();
    for (const op of this.known.values()) byId.set(op.id, { ...op, status: 'offline' });
    for (const c of this.conns.values()) {
      if (!c.operator) continue;
      const prev = byId.get(c.operator.id);
      const status = prev?.status === 'online' || c.status === 'online' ? 'online' : 'away';
      byId.set(c.operator.id, { ...c.operator, status, ...(c.simulated ? { simulated: true } : {}) });
    }
    return [...byId.values()];
  }

  presenceEvent(): PresenceEvent {
    return { v: PROTOCOL_VERSION, type: 'presence', ts: this.now(), operators: this.presence() };
  }

  broadcastPresence(): void {
    this.emit({ to: 'all' }, this.presenceEvent());
  }

  // -------------------------------------------------------------------------

  private now() {
    return this.opts.now();
  }

  private emit(target: HubTarget, ev: ServerEvent) {
    this.opts.emit(target, ev);
  }

  private resolveOperator(connId: string, requested: Operator, auto: boolean): Operator {
    const name = sanitizeText(requested.name, MAX_NAME);
    const base = HUMAN_OPERATORS.find((o) => o.id === requested.id) ?? (requested.id === SIM_OPERATOR.id ? SIM_OPERATOR : HUMAN_OPERATORS[0]);
    if (auto) {
      const taken = new Set([...this.conns.values()].filter((c) => c.id !== connId && c.operator).map((c) => c.operator!.id));
      if (taken.has(base.id)) {
        const free = HUMAN_OPERATORS.find((o) => !taken.has(o.id));
        if (free) return { ...free };
      }
    }
    return { id: base.id, name: name || base.name };
  }

  private touchRoom(room: string): ChatWireMessage[] {
    let list = this.rooms.get(room);
    if (list) {
      this.rooms.delete(room);
    } else {
      list = [];
      while (this.rooms.size >= this.maxRooms) {
        const oldest = [...this.rooms.keys()].find((k) => k !== GENERAL_ROOM);
        if (!oldest) break;
        this.rooms.delete(oldest);
      }
    }
    this.rooms.set(room, list);
    return list;
  }

  private setWorkflow(alert: AlertRef, patch: WorkflowState) {
    const prev = this.workflow.get(alert.id) ?? {};
    this.workflow.delete(alert.id);
    this.workflow.set(alert.id, { ...prev, ...patch });
    if (this.workflow.size > 500) this.workflow.delete(this.workflow.keys().next().value as string);
  }
}

function insertSorted(list: ChatWireMessage[], m: ChatWireMessage) {
  let i = list.length;
  while (i > 0 && list[i - 1].ts > m.ts) i--;
  list.splice(i, 0, m);
}

/** Route a hub target to a set of connection ids. */
export function resolveTargets(target: HubTarget, connIds: Iterable<string>): string[] {
  if (target.to === 'conn') return [target.id];
  const all = [...connIds];
  return target.to === 'all' ? all : all.filter((id) => id !== target.id);
}
