import { ChatHub, resolveTargets, type HubTarget } from './chat-hub';
import { PROTOCOL_VERSION as v, type ChatMessageEvent, type ServerEvent } from './protocol';
import { SimOperator } from './sim-operator';

function setup() {
  let now = 1_000;
  const sent: { target: HubTarget; ev: ServerEvent }[] = [];
  const hub = new ChatHub({ now: () => now, emit: (target, ev) => sent.push({ target, ev }), maxPerRoom: 5, maxRooms: 3 });
  return { hub, sent, tick: (ms: number) => (now += ms), now: () => now };
}

const join = (id: string, name: string, auto = false) => ({ v, type: 'join', operator: { id, name }, auto }) as const;

describe('ChatHub', () => {
  it('welcomes a joining operator and broadcasts presence', () => {
    const { hub, sent } = setup();
    hub.connect('c1');
    hub.handle('c1', join('op-a', 'Alice'));
    expect(sent[0]).toEqual({ target: { to: 'conn', id: 'c1' }, ev: expect.objectContaining({ type: 'welcome', operator: { id: 'op-a', name: 'Alice' } }) });
    expect(hub.presence()).toEqual([{ id: 'op-a', name: 'Alice', status: 'online' }]);
  });

  it('auto-assigns a free identity when the requested one is taken', () => {
    const { hub } = setup();
    hub.connect('c1');
    hub.connect('c2');
    hub.handle('c1', join('op-a', 'A', true));
    hub.handle('c2', join('op-a', 'A', true));
    expect(hub.operatorOf('c2')?.id).toBe('op-b');
  });

  it('broadcasts messages, dedupes resends by clientId and bounds history', () => {
    const { hub, sent, tick, now } = setup();
    hub.connect('c1');
    hub.handle('c1', join('op-a', 'A'));
    sent.length = 0;
    hub.handle('c1', { v, type: 'chat:send', clientId: 'x1', room: 'general', text: ' hello ', clientTs: now() });
    expect(sent).toHaveLength(1);
    expect(sent[0].target).toEqual({ to: 'all' });
    expect((sent[0].ev as ChatMessageEvent).message).toMatchObject({ id: 'x1', text: 'hello', from: 'op-a' });
    // Resend after reconnect: acknowledged only to the sender, not duplicated.
    hub.handle('c1', { v, type: 'chat:send', clientId: 'x1', room: 'general', text: 'hello', clientTs: now() });
    expect(sent[1].target).toEqual({ to: 'conn', id: 'c1' });
    expect(hub.history('general').messages).toHaveLength(1);
    for (let i = 0; i < 10; i++) {
      tick(10);
      hub.handle('c1', { v, type: 'chat:send', clientId: `m${i}`, room: 'general', text: `m${i}`, clientTs: now() });
    }
    expect(hub.history('general', Infinity, 100).messages).toHaveLength(5);
  });

  it('ignores messages before join and empty text', () => {
    const { hub, sent } = setup();
    hub.connect('c1');
    hub.handle('c1', { v, type: 'chat:send', clientId: 'x', room: 'general', text: 'hi', clientTs: 1 });
    hub.handle('c1', join('op-a', 'A'));
    sent.length = 0;
    hub.handle('c1', { v, type: 'chat:send', clientId: 'y', room: 'general', text: '   ', clientTs: 1 });
    expect(sent).toHaveLength(0);
  });

  it('records delivered/read receipts and relays them to the others', () => {
    const { hub, sent, now } = setup();
    hub.connect('a');
    hub.connect('b');
    hub.handle('a', join('op-a', 'A'));
    hub.handle('b', join('op-b', 'B'));
    hub.handle('a', { v, type: 'chat:send', clientId: 'm1', room: 'general', text: 'hi', clientTs: now() });
    sent.length = 0;
    hub.handle('b', { v, type: 'chat:receipt', room: 'general', kind: 'read', upTo: now() });
    const msg = hub.history('general').messages[0];
    expect(msg.deliveredTo).toEqual(['op-b']);
    expect(msg.readBy).toEqual(['op-b']);
    expect(sent[0]).toEqual({ target: { to: 'except', id: 'b' }, ev: expect.objectContaining({ type: 'chat:receipt', by: 'op-b', kind: 'read' }) });
  });

  it('pages history with `before`', () => {
    const { hub, tick, now } = setup();
    hub.connect('a');
    hub.handle('a', join('op-a', 'A'));
    for (let i = 0; i < 4; i++) {
      tick(100);
      hub.handle('a', { v, type: 'chat:send', clientId: `m${i}`, room: 'general', text: `${i}`, clientTs: now() });
    }
    const page = hub.history('general', Infinity, 2);
    expect(page.messages.map((m) => m.text)).toEqual(['2', '3']);
    expect(page.hasMore).toBe(true);
    const older = hub.history('general', page.messages[0].ts, 2);
    expect(older.messages.map((m) => m.text)).toEqual(['0', '1']);
    expect(older.hasMore).toBe(false);
  });

  it('evicts the least recently used room but never the general room', () => {
    const { hub, now } = setup();
    hub.connect('a');
    hub.handle('a', join('op-a', 'A'));
    for (const room of ['r1', 'r2', 'r3', 'r4']) hub.handle('a', { v, type: 'chat:send', clientId: room, room, text: 'x', clientTs: now() });
    expect(hub.roomIds()).toContain('general');
    expect(hub.roomIds()).toHaveLength(3);
    expect(hub.roomIds()).not.toContain('r1');
  });

  it('tracks alert workflow and reports offline operators after disconnect', () => {
    const { hub, sent } = setup();
    hub.connect('a');
    hub.handle('a', join('op-a', 'A'));
    const alert = { id: 'cam-01-a1', cam: 'cam-01', alertType: 'intrusion', severity: 'high' } as const;
    hub.handle('a', { v, type: 'alert:assign', alert, to: 'op-b' });
    hub.handle('a', { v, type: 'alert:ack', alert });
    expect(hub.workflowOf('cam-01-a1')).toEqual({ assignee: 'op-b', ackedBy: 'op-a' });
    expect(sent.some((s) => s.ev.type === 'alert:assigned')).toBe(true);
    hub.disconnect('a');
    expect(hub.presence()).toEqual([{ id: 'op-a', name: 'A', status: 'offline' }]);
  });

  it('resolves targets', () => {
    expect(resolveTargets({ to: 'all' }, ['a', 'b'])).toEqual(['a', 'b']);
    expect(resolveTargets({ to: 'except', id: 'a' }, ['a', 'b'])).toEqual(['b']);
    expect(resolveTargets({ to: 'conn', id: 'z' }, ['a'])).toEqual(['z']);
  });
});

describe('SimOperator', () => {
  it('acknowledges receipt, types and replies to a lone human', () => {
    const queue: { at: number; fn: () => void }[] = [];
    let now = 0;
    const toHuman: ServerEvent[] = [];
    let bot: SimOperator;
    const hub = new ChatHub({
      now: () => now,
      emit: (target, ev) => {
        for (const id of resolveTargets(target, hub.connectionIds())) {
          if (id === 'bot:sim') bot.onEvent(ev);
          else toHuman.push(ev);
        }
      },
    });
    bot = new SimOperator(hub, {
      now: () => now,
      rand: () => 0.5,
      schedule: (fn, ms) => queue.push({ at: now + ms, fn }),
      latestAlert: () => ({ id: 'cam-04-a1', cam: 'cam-04', alertType: 'crowding', severity: 'high' }),
    });
    bot.start();
    hub.connect('h');
    hub.handle('h', join('op-a', 'Alice'));
    hub.handle('h', { v, type: 'chat:send', clientId: 'q1', room: 'general', text: 'anything on platform B?', clientTs: now });
    const flush = (until: number) => {
      while (true) {
        queue.sort((a, b) => a.at - b.at);
        const next = queue[0];
        if (!next || next.at > until) break;
        queue.shift();
        now = next.at;
        next.fn();
      }
      now = until;
    };
    flush(20_000);
    const types = toHuman.map((e) => e.type);
    expect(types).toContain('chat:receipt');
    expect(types).toContain('chat:typing');
    const replies = toHuman.filter((e): e is ChatMessageEvent => e.type === 'chat:message' && e.message.from === 'op-sim');
    expect(replies.some((r) => r.message.text.includes('Checking the feed'))).toBe(true);
    // Proactive hand-over: assigns an alert to the human and @mentions them.
    now = 60_000;
    bot.tick();
    expect(toHuman.some((e) => e.type === 'alert:assigned' && e.to === 'op-a')).toBe(true);
  });
});
