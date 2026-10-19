/**
 * Demo-mode "server" that runs inside a Web Worker (or on the main thread as a
 * fallback). It hosts the same Simulator and ChatHub the Node server uses and
 * speaks the identical JSON protocol, plus a scripted second operator.
 */
import { ChatHub, resolveTargets, type HubTarget } from '../../shared/chat-hub';
import { mulberry32 } from '../../shared/geometry';
import { makePong, validateClientMessage, type Operator, type ServerEvent } from '../../shared/protocol';
import { SimOperator } from '../../shared/sim-operator';
import { Simulator } from '../../shared/simulator';

/** Main thread → engine. Strings are raw client protocol messages from the local operator. */
export type EngineInput =
  | string
  | { kind: 'peer'; op: Operator; msg: string }
  | { kind: 'peer-gone'; opId: string };

export const LOCAL_CONN = 'local';
const PEER_TTL_MS = 15_000;
const TICK_MS = 100;

export class DemoEngine {
  private readonly sim: Simulator;
  private readonly hub: ChatHub;
  private readonly bot: SimOperator;
  private readonly peers = new Map<string, number>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private last = 0;

  /** `post` receives a batch of wire strings for the local client. */
  constructor(
    private readonly post: (batch: string[]) => void,
    seed = Date.now() % 100_000,
  ) {
    this.sim = new Simulator({ seed, source: 'simulator' });
    const rand = mulberry32(seed + 7);
    this.hub = new ChatHub({ now: Date.now, emit: (t, ev) => this.route(t, ev) });
    this.bot = new SimOperator(this.hub, {
      now: Date.now,
      rand,
      schedule: (fn, ms) => void setTimeout(fn, ms),
      latestAlert: () => this.sim.recentAlerts(20).find((a) => a.severity === 'high' || a.severity === 'critical') ?? null,
    });
  }

  start(): void {
    const now = Date.now();
    this.last = now;
    this.hub.connect(LOCAL_CONN);
    this.post([JSON.stringify(this.sim.hello(now))]);
    // The simulated operator joins like any client; its join broadcasts presence.
    this.bot.start();
    this.timers.push(
      setInterval(() => {
        const t = Date.now();
        const events = this.sim.step(t - this.last, t);
        this.last = t;
        if (events.length) this.post(events.map((e) => JSON.stringify(e)));
      }, TICK_MS),
      setInterval(() => {
        this.bot.tick();
        const t = Date.now();
        for (const [connId, seen] of this.peers) {
          if (t - seen > PEER_TTL_MS) {
            this.peers.delete(connId);
            this.hub.disconnect(connId);
          }
        }
      }, 1000),
      setInterval(() => this.hub.broadcastPresence(), 10_000),
    );
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  receive(input: EngineInput): void {
    if (typeof input === 'string') {
      const msg = validateClientMessage(safeParse(input));
      if (!msg) return;
      if (msg.type === 'ping') this.post([JSON.stringify(makePong(msg, Date.now()))]);
      else this.hub.handle(LOCAL_CONN, msg);
      return;
    }
    if (input.kind === 'peer-gone') {
      const connId = `peer:${input.opId}`;
      this.peers.delete(connId);
      this.hub.disconnect(connId);
      return;
    }
    const msg = validateClientMessage(safeParse(input.msg));
    if (!msg || msg.type === 'ping') return;
    const connId = `peer:${input.op.id}`;
    if (!this.hub.isConnected(connId)) {
      this.hub.connect(connId);
      this.hub.handle(connId, { v: 1, type: 'join', operator: input.op, auto: false });
    }
    this.peers.set(connId, Date.now());
    if (msg.type !== 'join') this.hub.handle(connId, msg);
  }

  private route(target: HubTarget, ev: ServerEvent) {
    for (const id of resolveTargets(target, this.hub.connectionIds())) {
      if (id === LOCAL_CONN) this.post([JSON.stringify(ev)]);
      else if (id === this.bot.connId) this.bot.onEvent(ev);
      // peer:* connections are served by their own tab's engine replica.
    }
  }
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
