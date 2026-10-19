import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { PROTOCOL_VERSION as v, type ChatWireMessage, type ClientMessage, type ServerEvent } from '../../shared/protocol';
import { ApiService } from './api.service';
import {
  chatReducer,
  effectivePresence,
  initialChatState,
  mentions,
  outbox,
  totalUnread,
  typingIn,
  MAX_ROOM_MESSAGES,
  PRESENCE_TTL_MS,
  type ChatState,
} from './chat.reducer';
import { ACK_TIMEOUT_MS, ChatStore } from './chat.store';
import { RUNTIME_CONFIG } from './config';
import { FeedService } from './feed.service';
import { NotificationService } from './notifications.service';

const me = { id: 'op-a', name: 'Alice' };
const wire = (id: string, from: string, ts: number, room = 'general', text = 'hi'): ChatWireMessage => ({
  id,
  room,
  from,
  fromName: from === 'op-a' ? 'Alice' : 'Bob',
  text,
  ts,
  deliveredTo: [],
  readBy: [],
});
const withMe = (): ChatState => chatReducer(initialChatState, { type: 'welcome', operator: me });

describe('chatReducer', () => {
  it('tracks optimistic sends through sent → delivered → read', () => {
    let s = chatReducer(withMe(), { type: 'localSend', id: 'm1', room: 'general', text: 'hi', ts: 10 });
    expect(s.rooms['general'].messages[0]).toMatchObject({ status: 'pending', mine: true });
    expect(outbox(s).map((m) => m.id)).toEqual(['m1']);
    s = chatReducer(s, { type: 'message', message: wire('m1', 'op-a', 10) });
    expect(s.rooms['general'].messages).toHaveLength(1);
    expect(s.rooms['general'].messages[0].status).toBe('sent');
    expect(outbox(s)).toEqual([]);
    s = chatReducer(s, { type: 'receipt', room: 'general', by: 'op-b', kind: 'delivered', upTo: 10 });
    expect(s.rooms['general'].messages[0].status).toBe('delivered');
    s = chatReducer(s, { type: 'receipt', room: 'general', by: 'op-b', kind: 'read', upTo: 10 });
    expect(s.rooms['general'].messages[0].status).toBe('read');
    // A late "delivered" never downgrades.
    s = chatReducer(s, { type: 'receipt', room: 'general', by: 'op-b', kind: 'delivered', upTo: 10 });
    expect(s.rooms['general'].messages[0].status).toBe('read');
  });

  it('ignores receipts for later messages and my own receipts', () => {
    let s = chatReducer(withMe(), { type: 'message', message: wire('m1', 'op-a', 10) });
    s = chatReducer(s, { type: 'message', message: wire('m2', 'op-a', 20) });
    s = chatReducer(s, { type: 'receipt', room: 'general', by: 'op-b', kind: 'read', upTo: 15 });
    expect(s.rooms['general'].messages.map((m) => m.status)).toEqual(['read', 'sent']);
    const same = chatReducer(s, { type: 'receipt', room: 'general', by: 'op-a', kind: 'read', upTo: 99 });
    expect(same).toBe(s);
  });

  it('counts unread messages from others only while the room is not being viewed', () => {
    let s = chatReducer(withMe(), { type: 'message', message: wire('a', 'op-b', 1) });
    s = chatReducer(s, { type: 'message', message: wire('b', 'op-b', 2, 'alert-x') });
    s = chatReducer(s, { type: 'message', message: wire('c', 'op-a', 3) });
    expect(s.rooms['general'].unread).toBe(1);
    expect(totalUnread(s)).toBe(2);
    s = chatReducer(s, { type: 'viewing', viewing: true });
    expect(s.rooms['general'].unread).toBe(0);
    expect(s.rooms['general'].lastReadTs).toBe(1);
    expect(s.rooms['alert-x'].unread).toBe(1);
    s = chatReducer(s, { type: 'message', message: wire('d', 'op-b', 4) });
    expect(s.rooms['general'].unread).toBe(0);
    s = chatReducer(s, { type: 'open', room: 'alert-x', now: 5 });
    expect(totalUnread(s)).toBe(0);
  });

  it('marks failed sends and moves them back to pending on resend', () => {
    let s = chatReducer(withMe(), { type: 'localSend', id: 'm1', room: 'general', text: 'x', ts: 1 });
    s = chatReducer(s, { type: 'sendFailed', ids: ['m1'] });
    expect(s.rooms['general'].messages[0].status).toBe('failed');
    expect(outbox(s)).toHaveLength(1);
    s = chatReducer(s, { type: 'resending', ids: ['m1'] });
    expect(s.rooms['general'].messages[0].status).toBe('pending');
  });

  it('handles typing indicators with expiry', () => {
    let s = chatReducer(withMe(), { type: 'typing', room: 'general', from: 'op-b', typing: true, now: 0 });
    expect(typingIn(s, 'general', 100)).toEqual(['op-b']);
    expect(typingIn(s, 'general', 60_000)).toEqual([]);
    s = chatReducer(s, { type: 'message', message: wire('m', 'op-b', 5) });
    expect(typingIn(s, 'general', 100)).toEqual([]);
    s = chatReducer(s, { type: 'typing', room: 'general', from: 'op-a', typing: true, now: 0 });
    expect(s.typing).toEqual([]);
  });

  it('merges history without duplicates and bounds rooms', () => {
    let s = chatReducer(withMe(), { type: 'message', message: wire('m2', 'op-b', 2) });
    s = chatReducer(s, { type: 'history', room: 'general', messages: [wire('m1', 'op-b', 1), wire('m2', 'op-b', 2)], hasMore: false });
    expect(s.rooms['general'].messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(s.rooms['general'].hasMore).toBe(false);
    for (let i = 0; i < MAX_ROOM_MESSAGES + 10; i++) s = chatReducer(s, { type: 'message', message: wire(`x${i}`, 'op-b', 10 + i) });
    expect(s.rooms['general'].messages).toHaveLength(MAX_ROOM_MESSAGES);
  });

  it('expires stale presence and detects mentions', () => {
    const s = chatReducer(withMe(), { type: 'presence', operators: [{ id: 'op-b', name: 'Bob', status: 'online' }], now: 0 });
    expect(effectivePresence(s, 1000)[0].status).toBe('online');
    expect(effectivePresence(s, PRESENCE_TTL_MS + 1)[0].status).toBe('offline');
    expect(mentions('hey @alice look', me)).toBe(true);
    expect(mentions('hey @op-a', me)).toBe(true);
    expect(mentions('hey alice', me)).toBe(false);
  });
});

describe('ChatStore (reconnect resend)', () => {
  let events: Subject<ServerEvent>;
  let session: Subject<'live' | 'simulated'>;
  let sent: ClientMessage[];
  let online: boolean;

  beforeEach(() => {
    vi.useFakeTimers();
    events = new Subject();
    session = new Subject();
    sent = [];
    online = true;
    const feed = {
      events$: events.asObservable(),
      session$: session.asObservable(),
      simulator: null,
      state: () => ({ kind: 'simulated' }),
      send: (m: ClientMessage) => {
        if (!online) return false;
        sent.push(m);
        return true;
      },
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: FeedService, useValue: feed },
        { provide: ApiService, useValue: {} },
        { provide: RUNTIME_CONFIG, useValue: { feedMode: 'demo', forcedDemo: true, wsUrl: '', apiBase: '', operator: 'op-a' } },
      ],
    });
  });

  afterEach(() => vi.useRealTimers());

  const welcome = () => events.next({ v, type: 'welcome', ts: 0, operator: me });

  it('queues messages while offline and resends them (same clientId) on the next session', async () => {
    const store = TestBed.inject(ChatStore);
    store.start();
    welcome();
    online = false;
    expect(store.sendText('first')).toBe(true);
    const id = store.state().rooms['general'].messages[0].id;
    expect(store.state().rooms['general'].messages[0].status).toBe('failed');

    online = true;
    session.next('live');
    await vi.advanceTimersByTimeAsync(0);
    const join = sent.find((m) => m.type === 'join');
    expect(join).toMatchObject({ operator: { id: 'op-a' }, auto: false });
    const resend = sent.filter((m) => m.type === 'chat:send');
    expect(resend).toHaveLength(1);
    expect(resend[0]).toMatchObject({ clientId: id, text: 'first' });
    expect(store.state().rooms['general'].messages[0].status).toBe('pending');

    // Server echo acknowledges it.
    events.next({ v, type: 'chat:message', ts: 1, message: wire(id, 'op-a', store.state().rooms['general'].messages[0].ts, 'general', 'first') });
    expect(store.state().rooms['general'].messages[0].status).toBe('sent');
  });

  it('marks a message failed when no acknowledgement arrives in time', () => {
    const store = TestBed.inject(ChatStore);
    store.start();
    welcome();
    store.sendText('hello?');
    expect(store.state().rooms['general'].messages[0].status).toBe('pending');
    vi.advanceTimersByTime(ACK_TIMEOUT_MS + 10);
    expect(store.state().rooms['general'].messages[0].status).toBe('failed');
  });

  it('sends delivered receipts and raises a mention notification', () => {
    const store = TestBed.inject(ChatStore);
    const notifications = TestBed.inject(NotificationService);
    store.start();
    welcome();
    events.next({ v, type: 'chat:message', ts: 5, message: wire('b1', 'op-b', 5, 'general', 'ping @Alice') });
    vi.advanceTimersByTime(300);
    expect(sent.find((m) => m.type === 'chat:receipt')).toMatchObject({ kind: 'delivered', upTo: 5, room: 'general' });
    expect(notifications.items()[0]).toMatchObject({ kind: 'mention', room: 'general' });
    expect(store.unread()).toBe(1);
  });
});
