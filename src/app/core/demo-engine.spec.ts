import { PROTOCOL_VERSION as v, parseServerEvent, type ServerEvent } from '../../shared/protocol';
import { DemoEngine } from './demo-engine';

describe('DemoEngine (in-browser simulator speaking the wire protocol)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function boot() {
    const received: ServerEvent[] = [];
    const engine = new DemoEngine((batch) => {
      for (const raw of batch) {
        const r = parseServerEvent(raw);
        expect(r.ok).toBe(true);
        if (r.ok) received.push(r.event);
      }
    }, 123);
    engine.start();
    return { engine, received };
  }

  it('greets with hello + presence and streams frames', () => {
    const { engine, received } = boot();
    expect(received[0].type).toBe('hello');
    expect(received[1].type).toBe('presence');
    vi.advanceTimersByTime(1_000);
    expect(received.filter((e) => e.type === 'frame').length).toBeGreaterThan(30);
    expect(received.some((e) => e.type === 'stats')).toBe(true);
    engine.stop();
  });

  it('answers pings and runs the chat hub with a simulated operator', () => {
    const { engine, received } = boot();
    engine.receive(JSON.stringify({ v, type: 'ping', id: 4, clientTs: 1 }));
    expect(received.some((e) => e.type === 'pong' && e.id === 4)).toBe(true);
    engine.receive(JSON.stringify({ v, type: 'join', operator: { id: 'op-a', name: 'Alice' }, auto: true }));
    expect(received.some((e) => e.type === 'welcome')).toBe(true);
    const presence = received.filter((e) => e.type === 'presence').at(-1);
    expect(presence?.type === 'presence' && presence.operators.some((o) => o.simulated)).toBe(true);
    engine.receive(JSON.stringify({ v, type: 'chat:send', clientId: 'c1', room: 'general', text: 'hello?', clientTs: Date.now() }));
    vi.advanceTimersByTime(10_000);
    expect(received.some((e) => e.type === 'chat:receipt' && e.kind === 'read')).toBe(true);
    expect(received.some((e) => e.type === 'chat:message' && e.message.from === 'op-sim')).toBe(true);
    engine.stop();
  });

  it('replays peer-tab messages so two tabs can chat without a server', () => {
    const { engine, received } = boot();
    engine.receive(JSON.stringify({ v, type: 'join', operator: { id: 'op-a', name: 'Alice' }, auto: false }));
    engine.receive({ kind: 'peer', op: { id: 'op-b', name: 'Bob' }, msg: JSON.stringify({ v, type: 'chat:send', clientId: 'p1', room: 'general', text: 'from tab B', clientTs: Date.now() }) });
    const msg = received.find((e) => e.type === 'chat:message' && e.message.id === 'p1');
    expect(msg?.type === 'chat:message' && msg.message.fromName).toBe('Bob');
    engine.receive({ kind: 'peer-gone', opId: 'op-b' });
    const last = received.filter((e) => e.type === 'presence').at(-1);
    expect(last?.type === 'presence' && last.operators.find((o) => o.id === 'op-b')?.status).toBe('offline');
    engine.stop();
  });
});
