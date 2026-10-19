import { Observable, defer, filter, finalize, map } from 'rxjs';
import { webSocket, type WebSocketSubject } from 'rxjs/webSocket';
import { parseServerEvent, type ClientMessage, type Operator, type ServerEvent } from '../../shared/protocol';
import { DemoEngine } from './demo-engine';

export interface FeedSource {
  readonly kind: 'socket' | 'simulator';
  /** Cold: each subscription opens a new transport session. */
  connect(): Observable<ServerEvent>;
  /** Returns false when the transport cannot send right now. */
  send(msg: ClientMessage): boolean;
  close(): void;
}

function decode(raw: string): ServerEvent | null {
  const r = parseServerEvent(raw);
  return r.ok ? r.event : null;
}

/** Live server feed over `rxjs/webSocket`. */
export class SocketSource implements FeedSource {
  readonly kind = 'socket' as const;
  private subject: WebSocketSubject<string> | null = null;
  private open = false;
  invalid = 0;

  constructor(
    private readonly url: string,
    private readonly hooks: { onOpen: () => void; onClose: () => void },
  ) {}

  connect(): Observable<ServerEvent> {
    return defer(() => {
      const subject = webSocket<string>({
        url: this.url,
        deserializer: (e) => String(e.data),
        serializer: (v) => v,
        openObserver: {
          next: () => {
            this.open = true;
            this.hooks.onOpen();
          },
        },
        closeObserver: {
          next: () => {
            this.open = false;
            this.hooks.onClose();
          },
        },
      });
      this.subject = subject;
      return subject.pipe(
        map((raw) => {
          const ev = decode(raw);
          if (!ev) this.invalid++;
          return ev;
        }),
        filter((ev): ev is ServerEvent => ev !== null),
        finalize(() => {
          this.open = false;
          if (this.subject === subject) this.subject = null;
        }),
      );
    });
  }

  send(msg: ClientMessage): boolean {
    if (!this.subject || !this.open) return false;
    this.subject.next(JSON.stringify(msg));
    return true;
  }

  close(): void {
    this.subject?.complete();
    this.subject = null;
    this.open = false;
  }
}

type BcMessage =
  | { kind: 'msg'; op: Operator; msg: string }
  | { kind: 'probe' }
  | { kind: 'here'; op: Operator }
  | { kind: 'bye'; op: Operator };

export const BC_NAME = 'sentinel-live-demo';

/**
 * Demo feed: the simulator + chat hub run in a Web Worker (inline fallback when
 * workers are unavailable). Local client messages are mirrored to other tabs via
 * BroadcastChannel so two tabs can chat without a server.
 */
export class SimulatorSource implements FeedSource {
  readonly kind = 'simulator' as const;
  private worker: Worker | null = null;
  private inline: DemoEngine | null = null;
  private readonly bc: BroadcastChannel | null;
  private me: Operator | null = null;
  private readonly peersSeen = new Map<string, Operator>();
  private readonly onPageHide = () => this.me && this.bc?.postMessage({ kind: 'bye', op: this.me } satisfies BcMessage);

  constructor(private readonly seed = Date.now() % 100_000) {
    this.bc = typeof BroadcastChannel === 'function' ? new BroadcastChannel(BC_NAME) : null;
    if (this.bc) {
      this.bc.onmessage = (e: MessageEvent<BcMessage>) => this.onBroadcast(e.data);
      addEventListener('pagehide', this.onPageHide);
    }
  }

  /** Operator ids currently used by other tabs (demo cross-tab chat). */
  probePeers(waitMs = 350): Promise<string[]> {
    if (!this.bc) return Promise.resolve([]);
    this.bc.postMessage({ kind: 'probe' } satisfies BcMessage);
    return new Promise((resolve) => setTimeout(() => resolve([...this.peersSeen.keys()]), waitMs));
  }

  connect(): Observable<ServerEvent> {
    return new Observable<ServerEvent>((sub) => {
      const deliver = (batch: string[]) => {
        for (const raw of batch) {
          const ev = decode(raw);
          if (!ev) continue;
          if (ev.type === 'welcome') this.me = ev.operator;
          sub.next(ev);
        }
      };
      if (typeof Worker === 'function') {
        try {
          this.worker = new Worker(new URL('../workers/sim.worker', import.meta.url), { type: 'module' });
          this.worker.onmessage = (e: MessageEvent<string[]>) => deliver(e.data);
          this.worker.postMessage({ kind: 'start', seed: this.seed });
        } catch {
          this.worker = null;
        }
      }
      if (!this.worker) {
        this.inline = new DemoEngine(deliver, this.seed);
        this.inline.start();
      }
      return () => this.close();
    });
  }

  send(msg: ClientMessage): boolean {
    const raw = JSON.stringify(msg);
    if (this.worker) this.worker.postMessage(raw);
    else if (this.inline) this.inline.receive(raw);
    else return false;
    if (msg.type !== 'ping' && this.bc) {
      const op = msg.type === 'join' ? msg.operator : this.me;
      if (op) this.bc.postMessage({ kind: 'msg', op, msg: raw } satisfies BcMessage);
    }
    return true;
  }

  close(): void {
    this.onPageHide();
    this.worker?.terminate();
    this.worker = null;
    this.inline?.stop();
    this.inline = null;
    if (this.bc) {
      removeEventListener('pagehide', this.onPageHide);
      this.bc.close();
    }
  }

  private toEngine(input: Parameters<DemoEngine['receive']>[0]) {
    if (this.worker) this.worker.postMessage(input);
    else this.inline?.receive(input);
  }

  private onBroadcast(m: BcMessage) {
    switch (m.kind) {
      case 'probe':
        if (this.me) this.bc?.postMessage({ kind: 'here', op: this.me } satisfies BcMessage);
        return;
      case 'here':
        this.peersSeen.set(m.op.id, m.op);
        return;
      case 'msg':
        if (m.op.id === this.me?.id) return; // same identity in two tabs: ignore own echo
        this.peersSeen.set(m.op.id, m.op);
        this.toEngine({ kind: 'peer', op: m.op, msg: m.msg });
        return;
      case 'bye':
        this.peersSeen.delete(m.op.id);
        this.toEngine({ kind: 'peer-gone', opId: m.op.id });
        return;
    }
  }
}
