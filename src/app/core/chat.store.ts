import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { Subject, debounceTime, groupBy, interval, mergeMap } from 'rxjs';
import { HUMAN_OPERATORS } from '../../shared/chat-hub';
import {
  GENERAL_ROOM,
  MAX_NAME,
  PROTOCOL_VERSION,
  sanitizeText,
  type AlertRef,
  type ClientMessage,
  type Operator,
  type ServerEvent,
} from '../../shared/protocol';
import { ApiService } from './api.service';
import {
  chatReducer,
  effectivePresence,
  initialChatState,
  mentions,
  outbox,
  roomList,
  totalUnread,
  typingIn,
  type ChatAction,
} from './chat.reducer';
import { RUNTIME_CONFIG } from './config';
import { FeedService } from './feed.service';
import { I18n } from './i18n';
import { NotificationService } from './notifications.service';

export type DockMode = 'closed' | 'docked' | 'floating';

export const ACK_TIMEOUT_MS = 6_000;
const TYPING_THROTTLE_MS = 2_500;
const TYPING_IDLE_MS = 3_000;
const PRESENCE_HEARTBEAT_MS = 5_000;
const ID_KEY = 'sentinel.operator';

export function newClientId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Operator chat over the same transport as the analytics feed.
 * Optimistic sends with an outbox that is re-sent (idempotently, by clientId)
 * on every new session; delivered / read receipts; typing; presence.
 */
@Injectable({ providedIn: 'root' })
export class ChatStore {
  private readonly feed = inject(FeedService);
  private readonly api = inject(ApiService);
  private readonly notifications = inject(NotificationService);
  private readonly i18n = inject(I18n);
  private readonly config = inject(RUNTIME_CONFIG);
  private readonly destroyRef = inject(DestroyRef);

  readonly state = signal(initialChatState);
  readonly dock = signal<DockMode>('closed');
  private readonly visible = signal(typeof document === 'undefined' ? true : !document.hidden);
  private readonly clock = signal(Date.now());

  readonly me = computed(() => this.state().me);
  readonly rooms = computed(() => roomList(this.state()));
  readonly activeRoom = computed(() => this.state().rooms[this.state().active]);
  readonly unread = computed(() => totalUnread(this.state()));
  readonly presence = computed(() => effectivePresence(this.state(), this.clock()));
  readonly others = computed(() => this.presence().filter((o) => o.id !== this.me()?.id));
  readonly simulatedPeer = computed(() => this.others().some((o) => o.simulated && o.status !== 'offline'));
  readonly typingNames = computed(() =>
    typingIn(this.state(), this.state().active, this.clock()).map((id) => this.nameOf(id)),
  );

  private readonly receiptIn = new Subject<{ room: string; upTo: number }>();
  private readonly lastReadSent = new Map<string, number>();
  private readonly ackTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private typingSentAt = 0;
  private typingRoom: string | null = null;
  private typingIdle: ReturnType<typeof setTimeout> | null = null;
  private started = false;

  constructor() {
    // viewing = panel open and tab visible → drives unread clearing + read receipts.
    effect(() => {
      const viewing = this.dock() !== 'closed' && this.visible();
      untracked(() => this.dispatch({ type: 'viewing', viewing }));
    });
    // Send a read receipt whenever the active room has unseen messages from others.
    effect(() => {
      const s = this.state();
      if (!s.viewing || !s.me) return;
      const room = s.rooms[s.active];
      if (!room) return;
      const latest = room.lastReadTs;
      if (latest > (this.lastReadSent.get(room.id) ?? 0)) {
        this.lastReadSent.set(room.id, latest);
        untracked(() => this.send({ v: PROTOCOL_VERSION, type: 'chat:receipt', room: room.id, kind: 'read', upTo: latest }));
      }
    });
  }

  dispatch(action: ChatAction): void {
    this.state.update((s) => chatReducer(s, action));
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const onVisibility = () => {
      this.visible.set(!document.hidden);
      this.send({ v: PROTOCOL_VERSION, type: 'presence', status: document.hidden ? 'away' : 'online' });
    };
    document.addEventListener('visibilitychange', onVisibility);
    const subs = [
      this.feed.events$.subscribe((ev) => this.onEvent(ev)),
      this.feed.session$.subscribe(() => void this.join()),
      // Delivered receipts: coalesce per room.
      this.receiptIn
        .pipe(
          groupBy((r) => r.room),
          mergeMap((g) => g.pipe(debounceTime(250))),
        )
        .subscribe((r) => this.send({ v: PROTOCOL_VERSION, type: 'chat:receipt', room: r.room, kind: 'delivered', upTo: r.upTo })),
      interval(1000).subscribe(() => {
        this.clock.set(Date.now());
        this.dispatch({ type: 'prune', now: Date.now() });
      }),
      interval(PRESENCE_HEARTBEAT_MS).subscribe(() =>
        this.send({ v: PROTOCOL_VERSION, type: 'presence', status: document.hidden ? 'away' : 'online' }),
      ),
    ];
    this.destroyRef.onDestroy(() => {
      subs.forEach((s) => s.unsubscribe());
      document.removeEventListener('visibilitychange', onVisibility);
    });
  }

  nameOf(id: string): string {
    if (id === this.me()?.id) return this.i18n.t('you');
    return this.state().operators[id]?.name ?? HUMAN_OPERATORS.find((o) => o.id === id)?.name ?? id;
  }

  openPanel(room?: string, alert?: AlertRef): void {
    if (this.dock() === 'closed') this.dock.set(matchMedia?.('(min-width: 1180px)').matches ? 'docked' : 'floating');
    if (room) this.openRoom(room, alert);
  }

  openRoom(room: string, alert?: AlertRef): void {
    const isNew = !this.state().rooms[room];
    this.dispatch({ type: 'open', room, alert, now: Date.now() });
    if (isNew || !this.state().rooms[room].messages.length) this.loadHistory(room);
  }

  loadHistory(room: string, older = false): void {
    if (this.feed.state().kind !== 'live') return;
    const r = this.state().rooms[room];
    const before = older && r?.messages.length ? r.messages[0].ts : undefined;
    this.api.chatHistory(room, before).subscribe((h) => {
      if (h) this.dispatch({ type: 'history', room, messages: h.messages, hasMore: h.hasMore });
    });
  }

  sendText(raw: string): boolean {
    const text = sanitizeText(raw);
    const me = this.me();
    if (!text || !me) return false;
    const room = this.state().active;
    const id = newClientId();
    const ts = Date.now();
    this.dispatch({ type: 'localSend', id, room, text, ts });
    this.stopTyping();
    this.transmit(id);
    return true;
  }

  retry(id: string): void {
    this.dispatch({ type: 'resending', ids: [id] });
    this.transmit(id);
  }

  /** Called on composer input. Throttled typing:true, idle → typing:false. */
  typing(): void {
    const room = this.state().active;
    const now = Date.now();
    if (this.typingRoom !== room || now - this.typingSentAt > TYPING_THROTTLE_MS) {
      if (this.typingRoom && this.typingRoom !== room) this.stopTyping();
      this.typingRoom = room;
      this.typingSentAt = now;
      this.send({ v: PROTOCOL_VERSION, type: 'chat:typing', room, typing: true });
    }
    if (this.typingIdle) clearTimeout(this.typingIdle);
    this.typingIdle = setTimeout(() => this.stopTyping(), TYPING_IDLE_MS);
  }

  chooseOperator(id: string, name: string): void {
    const base = HUMAN_OPERATORS.find((o) => o.id === id) ?? HUMAN_OPERATORS[0];
    const op: Operator = { id: base.id, name: sanitizeText(name, MAX_NAME) || base.name };
    this.persist(op);
    this.send({ v: PROTOCOL_VERSION, type: 'join', operator: op, auto: false });
  }

  // -------------------------------------------------------------------------

  private stopTyping() {
    if (this.typingIdle) clearTimeout(this.typingIdle);
    this.typingIdle = null;
    if (this.typingRoom) this.send({ v: PROTOCOL_VERSION, type: 'chat:typing', room: this.typingRoom, typing: false });
    this.typingRoom = null;
    this.typingSentAt = 0;
  }

  private send(msg: ClientMessage): boolean {
    return this.feed.send(msg);
  }

  private transmit(id: string) {
    const msg = outbox(this.state()).find((m) => m.id === id);
    if (!msg) return;
    const ok = this.send({ v: PROTOCOL_VERSION, type: 'chat:send', clientId: msg.id, room: msg.room, text: msg.text, clientTs: msg.ts });
    const prev = this.ackTimers.get(id);
    if (prev) clearTimeout(prev);
    if (!ok) {
      this.dispatch({ type: 'sendFailed', ids: [id] });
      return;
    }
    this.ackTimers.set(
      id,
      setTimeout(() => {
        this.ackTimers.delete(id);
        if (outbox(this.state()).some((m) => m.id === id && m.status === 'pending')) this.dispatch({ type: 'sendFailed', ids: [id] });
      }, ACK_TIMEOUT_MS),
    );
  }

  private async join() {
    const stored = readStored();
    const explicit = this.config.operator ?? stored?.id ?? null;
    let requested = HUMAN_OPERATORS.find((o) => o.id === (explicit ?? 'op-a')) ?? HUMAN_OPERATORS[0];
    const sim = this.feed.simulator;
    if (!explicit && sim) {
      // Demo cross-tab: pick an operator identity no other tab is using.
      const taken = await sim.probePeers();
      requested = HUMAN_OPERATORS.find((o) => !taken.includes(o.id)) ?? requested;
    }
    const name = stored?.id === requested.id ? stored.name : requested.name;
    this.send({ v: PROTOCOL_VERSION, type: 'join', operator: { id: requested.id, name }, auto: !explicit });
    // Optimistic outbox: resend everything not yet acknowledged (server dedupes by clientId).
    const pending = outbox(this.state()).map((m) => m.id);
    if (pending.length) {
      this.dispatch({ type: 'resending', ids: pending });
      for (const id of pending) this.transmit(id);
    }
    this.loadHistory(this.state().active);
  }

  private persist(op: Operator) {
    try {
      sessionStorage.setItem(ID_KEY, JSON.stringify(op));
    } catch {
      /* ignore */
    }
  }

  private onEvent(ev: ServerEvent) {
    switch (ev.type) {
      case 'welcome':
        this.dispatch({ type: 'welcome', operator: ev.operator });
        this.persist(ev.operator);
        return;
      case 'presence':
        this.dispatch({ type: 'presence', operators: ev.operators, now: Date.now() });
        return;
      case 'chat:typing':
        this.dispatch({ type: 'typing', room: ev.room, from: ev.from, typing: ev.typing, now: Date.now() });
        return;
      case 'chat:receipt':
        this.dispatch({ type: 'receipt', room: ev.room, by: ev.by, kind: ev.kind, upTo: ev.upTo });
        return;
      case 'chat:message': {
        const m = ev.message;
        const me = this.me();
        const before = this.state();
        const known = before.rooms[m.room]?.messages.some((x) => x.id === m.id);
        this.dispatch({ type: 'message', message: m });
        const timer = this.ackTimers.get(m.id);
        if (timer) {
          clearTimeout(timer);
          this.ackTimers.delete(m.id);
        }
        if (known || !me || m.from === me.id) return;
        this.receiptIn.next({ room: m.room, upTo: m.ts });
        const focused = before.viewing && before.active === m.room;
        if (mentions(m.text, me)) {
          this.notifications.notify({ kind: 'mention', title: this.i18n.t('nMention', { by: m.fromName }), body: m.text, room: m.room });
        } else if (!focused) {
          this.notifications.notify({ kind: 'message', title: this.i18n.t('nMessage', { by: m.fromName }), body: m.text, room: m.room });
        }
        return;
      }
      default:
        return;
    }
  }
}

function readStored(): Operator | null {
  try {
    const raw = sessionStorage.getItem(ID_KEY);
    if (!raw) return null;
    const op = JSON.parse(raw) as Operator;
    return HUMAN_OPERATORS.some((o) => o.id === op?.id) && typeof op.name === 'string' ? op : null;
  } catch {
    return null;
  }
}
