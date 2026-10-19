import {
  GENERAL_ROOM,
  type AlertRef,
  type ChatWireMessage,
  type Operator,
  type OperatorPresence,
  type ReceiptKind,
} from '../../shared/protocol';

export type MsgStatus = 'pending' | 'failed' | 'sent' | 'delivered' | 'read';

export interface ChatMsg {
  id: string;
  room: string;
  from: string;
  fromName: string;
  text: string;
  ts: number;
  mine: boolean;
  status: MsgStatus;
}

export interface Room {
  id: string;
  /** Oldest → newest, bounded by MAX_ROOM_MESSAGES. */
  messages: ChatMsg[];
  unread: number;
  /** Latest message ts from others that we have read. */
  lastReadTs: number;
  hasMore: boolean;
  alert?: AlertRef;
  lastActivity: number;
}

export interface TypingEntry {
  room: string;
  from: string;
  until: number;
}

export interface KnownOperator extends OperatorPresence {
  seenAt: number;
}

export interface ChatState {
  me: Operator | null;
  rooms: Record<string, Room>;
  active: string;
  /** True when the chat panel is open and the document is visible. */
  viewing: boolean;
  operators: Record<string, KnownOperator>;
  typing: TypingEntry[];
}

export const MAX_ROOM_MESSAGES = 200;
export const MAX_ROOMS = 40;
export const TYPING_TTL_MS = 6_000;
export const PRESENCE_TTL_MS = 25_000;

const emptyRoom = (id: string, now = 0): Room => ({ id, messages: [], unread: 0, lastReadTs: 0, hasMore: true, lastActivity: now });

export const initialChatState: ChatState = {
  me: null,
  rooms: { [GENERAL_ROOM]: emptyRoom(GENERAL_ROOM) },
  active: GENERAL_ROOM,
  viewing: false,
  operators: {},
  typing: [],
};

export type ChatAction =
  | { type: 'welcome'; operator: Operator }
  | { type: 'localSend'; id: string; room: string; text: string; ts: number }
  | { type: 'message'; message: ChatWireMessage }
  | { type: 'receipt'; room: string; by: string; kind: ReceiptKind; upTo: number }
  | { type: 'typing'; room: string; from: string; typing: boolean; now: number }
  | { type: 'open'; room: string; alert?: AlertRef; now: number }
  | { type: 'viewing'; viewing: boolean }
  | { type: 'history'; room: string; messages: ChatWireMessage[]; hasMore: boolean }
  | { type: 'presence'; operators: OperatorPresence[]; now: number }
  | { type: 'sendFailed'; ids: string[] }
  | { type: 'resending'; ids: string[] }
  | { type: 'prune'; now: number };

const RANK: Record<MsgStatus, number> = { failed: 0, pending: 0, sent: 1, delivered: 2, read: 3 };

function upgrade(current: MsgStatus, next: MsgStatus): MsgStatus {
  return RANK[next] > RANK[current] ? next : current;
}

function statusFromWire(m: ChatWireMessage, me: string | undefined): MsgStatus {
  const others = (list: string[]) => list.some((id) => id !== me);
  if (others(m.readBy)) return 'read';
  if (others(m.deliveredTo)) return 'delivered';
  return 'sent';
}

function fromWire(m: ChatWireMessage, me: Operator | null): ChatMsg {
  const mine = !!me && m.from === me.id;
  return {
    id: m.id,
    room: m.room,
    from: m.from,
    fromName: m.fromName,
    text: m.text,
    ts: m.ts,
    mine,
    status: mine ? statusFromWire(m, me?.id) : 'sent',
  };
}

function insertMsg(list: ChatMsg[], msg: ChatMsg): ChatMsg[] {
  const out = list.slice();
  let i = out.length;
  while (i > 0 && out[i - 1].ts > msg.ts) i--;
  out.splice(i, 0, msg);
  if (out.length > MAX_ROOM_MESSAGES) out.splice(0, out.length - MAX_ROOM_MESSAGES);
  return out;
}

function boundRooms(rooms: Record<string, Room>, keep: string): Record<string, Room> {
  const ids = Object.keys(rooms);
  if (ids.length <= MAX_ROOMS) return rooms;
  const victims = ids
    .filter((id) => id !== GENERAL_ROOM && id !== keep)
    .sort((a, b) => rooms[a].lastActivity - rooms[b].lastActivity)
    .slice(0, ids.length - MAX_ROOMS);
  const out = { ...rooms };
  for (const v of victims) delete out[v];
  return out;
}

const isFocused = (s: ChatState, room: string) => s.viewing && s.active === room;

function withRoom(s: ChatState, room: Room): ChatState {
  return { ...s, rooms: boundRooms({ ...s.rooms, [room.id]: room }, room.id) };
}

function markRead(room: Room): Room {
  const lastOther = [...room.messages].reverse().find((m) => !m.mine);
  return room.unread === 0 && (!lastOther || lastOther.ts <= room.lastReadTs)
    ? room
    : { ...room, unread: 0, lastReadTs: Math.max(room.lastReadTs, lastOther?.ts ?? 0) };
}

/** Pure chat reducer. */
export function chatReducer(s: ChatState, a: ChatAction): ChatState {
  switch (a.type) {
    case 'welcome': {
      // Re-evaluate ownership of existing messages under the (possibly new) identity.
      const rooms: Record<string, Room> = {};
      for (const [id, r] of Object.entries(s.rooms)) {
        rooms[id] = { ...r, messages: r.messages.map((m) => ({ ...m, mine: m.from === a.operator.id })) };
      }
      return { ...s, me: a.operator, rooms };
    }
    case 'localSend': {
      if (!s.me) return s;
      const room = s.rooms[a.room] ?? emptyRoom(a.room, a.ts);
      const msg: ChatMsg = { id: a.id, room: a.room, from: s.me.id, fromName: s.me.name, text: a.text, ts: a.ts, mine: true, status: 'pending' };
      return withRoom(s, { ...room, messages: insertMsg(room.messages, msg), lastActivity: a.ts });
    }
    case 'message': {
      const m = a.message;
      const room = s.rooms[m.room] ?? emptyRoom(m.room, m.ts);
      const existing = room.messages.findIndex((x) => x.id === m.id);
      const incoming = fromWire(m, s.me);
      let next: Room;
      if (existing >= 0) {
        const prev = room.messages[existing];
        const messages = room.messages.slice();
        messages[existing] = { ...prev, ts: m.ts, status: prev.mine ? upgrade(prev.status, incoming.status) : prev.status };
        next = { ...room, messages };
      } else {
        next = { ...room, messages: insertMsg(room.messages, incoming), lastActivity: Math.max(room.lastActivity, m.ts) };
        if (!incoming.mine) {
          next = isFocused(s, m.room) ? markRead(next) : { ...next, unread: next.unread + 1 };
        }
      }
      const typing = s.typing.filter((t) => !(t.room === m.room && t.from === m.from));
      return { ...withRoom(s, next), typing };
    }
    case 'receipt': {
      const room = s.rooms[a.room];
      if (!room || a.by === s.me?.id) return s;
      let changed = false;
      const messages = room.messages.map((m) => {
        if (!m.mine || m.ts > a.upTo || m.status === 'pending' || m.status === 'failed') return m;
        const status = upgrade(m.status, a.kind);
        if (status === m.status) return m;
        changed = true;
        return { ...m, status };
      });
      return changed ? withRoom(s, { ...room, messages }) : s;
    }
    case 'typing': {
      if (a.from === s.me?.id) return s;
      const rest = s.typing.filter((t) => !(t.room === a.room && t.from === a.from));
      return { ...s, typing: a.typing ? [...rest, { room: a.room, from: a.from, until: a.now + TYPING_TTL_MS }] : rest };
    }
    case 'open': {
      const base = s.rooms[a.room] ?? emptyRoom(a.room, a.now);
      let room = a.alert ? { ...base, alert: a.alert } : base;
      if (s.viewing) room = markRead(room);
      return { ...withRoom(s, room), active: a.room };
    }
    case 'viewing': {
      if (s.viewing === a.viewing) return s;
      const next = { ...s, viewing: a.viewing };
      const room = next.rooms[next.active];
      return a.viewing && room ? withRoom(next, markRead(room)) : next;
    }
    case 'history': {
      const room = s.rooms[a.room] ?? emptyRoom(a.room);
      let messages = room.messages;
      const known = new Set(messages.map((m) => m.id));
      for (const w of a.messages) if (!known.has(w.id)) messages = insertMsg(messages, fromWire(w, s.me));
      // History is, by definition, already seen: advance the read marker.
      const lastOther = a.messages.filter((m) => m.from !== s.me?.id).at(-1)?.ts ?? 0;
      return withRoom(s, { ...room, messages, hasMore: a.hasMore, lastReadTs: Math.max(room.lastReadTs, lastOther) });
    }
    case 'presence': {
      const operators = { ...s.operators };
      for (const o of a.operators) operators[o.id] = { ...o, seenAt: a.now };
      return { ...s, operators };
    }
    case 'sendFailed':
    case 'resending': {
      const ids = new Set(a.ids);
      const target: MsgStatus = a.type === 'sendFailed' ? 'failed' : 'pending';
      let next = s;
      for (const room of Object.values(s.rooms)) {
        if (!room.messages.some((m) => ids.has(m.id))) continue;
        const messages = room.messages.map((m) =>
          ids.has(m.id) && (m.status === 'pending' || m.status === 'failed') ? { ...m, status: target } : m,
        );
        next = withRoom(next, { ...room, messages });
      }
      return next;
    }
    case 'prune': {
      const typing = s.typing.filter((t) => t.until > a.now);
      return typing.length === s.typing.length ? s : { ...s, typing };
    }
  }
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

/** Own messages not yet acknowledged by the server, oldest first. */
export function outbox(s: ChatState): ChatMsg[] {
  return Object.values(s.rooms)
    .flatMap((r) => r.messages.filter((m) => m.mine && (m.status === 'pending' || m.status === 'failed')))
    .sort((a, b) => a.ts - b.ts);
}

export function totalUnread(s: ChatState): number {
  return Object.values(s.rooms).reduce((n, r) => n + r.unread, 0);
}

/** Effective presence: entries not refreshed within PRESENCE_TTL_MS are offline. */
export function effectivePresence(s: ChatState, now: number): KnownOperator[] {
  return Object.values(s.operators).map((o) => (now - o.seenAt > PRESENCE_TTL_MS ? { ...o, status: 'offline' } : o));
}

export function typingIn(s: ChatState, room: string, now: number): string[] {
  return s.typing.filter((t) => t.room === room && t.until > now).map((t) => t.from);
}

/** Rooms ordered: general first, then by latest activity. */
export function roomList(s: ChatState): Room[] {
  return Object.values(s.rooms).sort((a, b) =>
    a.id === GENERAL_ROOM ? -1 : b.id === GENERAL_ROOM ? 1 : b.lastActivity - a.lastActivity,
  );
}

/** Does `text` @mention operator `op` (by display name or id)? */
export function mentions(text: string, op: Operator | null): boolean {
  if (!op) return false;
  const t = text.toLowerCase();
  return t.includes(`@${op.name.toLowerCase()}`) || t.includes(`@${op.id.toLowerCase()}`);
}
