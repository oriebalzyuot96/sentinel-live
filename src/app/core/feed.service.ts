import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import {
  EMPTY,
  Observable,
  Subject,
  Subscription,
  catchError,
  defer,
  ignoreElements,
  interval,
  merge,
  retry,
  share,
  tap,
  throwError,
  timeout,
  timer,
} from 'rxjs';
import { PROTOCOL_VERSION, type ClientMessage, type ServerEvent } from '../../shared/protocol';
import { backoffDelay } from './backoff';
import { RUNTIME_CONFIG } from './config';
import { SimulatorSource, SocketSource, type FeedSource } from './feed-sources';
import { RingBuffer } from './ring-buffer';

export type ConnState =
  | { kind: 'connecting' }
  | { kind: 'live' }
  | { kind: 'reconnecting'; attempt: number; retryAt: number }
  | { kind: 'simulated'; reason: 'forced' | 'config' | 'fallback' | 'manual' };

export const HEARTBEAT_MS = 2_000;
export const STALE_MS = 7_000;
export const CONNECT_TIMEOUT_MS = 4_000;
export const REPLAY_WINDOW_MS = 30_000;
/** ~35 s of traffic at 6 cameras × 10 fps. */
export const RING_CAPACITY = 2_400;
const EPS_HISTORY = 60;

const ANALYTICS = new Set<ServerEvent['type']>(['hello', 'frame', 'alert', 'stats']);

/**
 * Owns the transport: live WebSocket (with heartbeat, stale detection and
 * exponential-backoff reconnect) or the in-browser simulator. Exposes:
 *  - `events$`  every decoded event (chat / workflow consumers)
 *  - `display$` analytics events gated by pause / replay (dashboard consumers)
 */
@Injectable({ providedIn: 'root' })
export class FeedService {
  private readonly config = inject(RUNTIME_CONFIG);

  readonly state = signal<ConnState>({ kind: 'connecting' });
  readonly rttMs = signal<number | null>(null);
  readonly eventsPerSec = signal(0);
  readonly epsHistory = signal<number[]>([]);
  readonly paused = signal(false);
  readonly replaying = signal(false);
  readonly replayProgress = signal(0);
  readonly bufferedSeconds = signal(0);

  private readonly eventsSubject = new Subject<ServerEvent>();
  private readonly displaySubject = new Subject<ServerEvent>();
  private readonly sessionSubject = new Subject<'live' | 'simulated'>();
  readonly events$: Observable<ServerEvent> = this.eventsSubject.asObservable();
  readonly display$: Observable<ServerEvent> = this.displaySubject.asObservable();
  /** Emits whenever a new transport session is ready (initial connect, reconnect, switch to demo). */
  readonly session$: Observable<'live' | 'simulated'> = this.sessionSubject.asObservable();

  private readonly ring = new RingBuffer<ServerEvent>(RING_CAPACITY);
  private source: FeedSource | null = null;
  private sub: Subscription | null = null;
  private replaySub: Subscription | null = null;
  private pingId = 0;
  private epsCount = 0;
  private started = false;

  constructor() {
    const tick = interval(1000).subscribe(() => {
      this.eventsPerSec.set(this.epsCount);
      this.epsHistory.update((h) => [...h.slice(-(EPS_HISTORY - 1)), this.epsCount]);
      this.epsCount = 0;
      const first = this.ring.takeLastWhile((e) => e.ts >= Date.now() - REPLAY_WINDOW_MS)[0];
      this.bufferedSeconds.set(first ? Math.min(30, Math.round((Date.now() - first.ts) / 1000)) : 0);
    });
    inject(DestroyRef).onDestroy(() => {
      tick.unsubscribe();
      this.teardown();
    });
  }

  get mode() {
    return this.config.feedMode;
  }

  /** Simulator source when in demo mode (for cross-tab peer probing). */
  get simulator(): SimulatorSource | null {
    return this.source instanceof SimulatorSource ? this.source : null;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    if (this.config.feedMode === 'demo') this.startSimulated(this.config.forcedDemo ? 'forced' : 'config');
    else this.startLive(this.config.feedMode === 'auto');
  }

  /** Switch to the live server (from demo). Falls back again if it cannot connect. */
  tryLive(): void {
    this.startLive(true);
  }

  useSimulated(): void {
    this.startSimulated('manual');
  }

  send(msg: ClientMessage): boolean {
    return this.source?.send(msg) ?? false;
  }

  togglePause(): void {
    this.paused.update((p) => !p);
  }

  /** Re-play the last `REPLAY_WINDOW_MS` of analytics events from the ring buffer. */
  replay(speed = 2): void {
    if (this.replaying()) return this.stopReplay();
    const since = Date.now() - REPLAY_WINDOW_MS;
    const items = this.ring.takeLastWhile((e) => e.ts >= since);
    if (!items.length) return;
    const t0 = items[0].ts;
    let i = 0;
    const startedAt = performance.now();
    this.replaying.set(true);
    this.replayProgress.set(0);
    this.replaySub = interval(50).subscribe(() => {
      const elapsed = (performance.now() - startedAt) * speed;
      while (i < items.length && items[i].ts - t0 <= elapsed) this.displaySubject.next(items[i++]);
      this.replayProgress.set(i / items.length);
      if (i >= items.length) this.stopReplay();
    });
  }

  stopReplay(): void {
    this.replaySub?.unsubscribe();
    this.replaySub = null;
    this.replaying.set(false);
    this.replayProgress.set(0);
  }

  // -------------------------------------------------------------------------

  private teardown() {
    this.sub?.unsubscribe();
    this.sub = null;
    this.source?.close();
    this.source = null;
    this.rttMs.set(null);
  }

  private startSimulated(reason: Extract<ConnState, { kind: 'simulated' }>['reason']) {
    this.teardown();
    const src = new SimulatorSource();
    this.source = src;
    this.state.set({ kind: 'simulated', reason });
    const pings = interval(HEARTBEAT_MS).pipe(
      tap(() => src.send(this.ping())),
      ignoreElements(),
    );
    this.sub = merge(src.connect(), pings).subscribe((ev) => this.ingest(ev));
    this.sessionSubject.next('simulated');
  }

  private startLive(allowFallback: boolean) {
    this.teardown();
    this.state.set({ kind: 'connecting' });
    let everConnected = false;
    let lastMessageAt = 0;
    let opened = false;

    const session$ = defer(() => {
      opened = false;
      const src = new SocketSource(this.config.wsUrl, {
        onOpen: () => {
          opened = true;
          everConnected = true;
          lastMessageAt = Date.now();
          this.state.set({ kind: 'live' });
          this.sessionSubject.next('live');
        },
        onClose: () => (opened = false),
      });
      this.source = src;
      const messages$ = src.connect().pipe(timeout({ first: CONNECT_TIMEOUT_MS }), share());
      // Heartbeat: ping for RTT, and fail the session if the server goes silent.
      const watchdog$ = interval(HEARTBEAT_MS).pipe(
        tap(() => {
          if (!opened) return;
          if (Date.now() - lastMessageAt > STALE_MS) throw new Error('stale connection');
          src.send(this.ping());
        }),
        ignoreElements(),
      );
      return merge(messages$, watchdog$);
    }).pipe(
      tap(() => (lastMessageAt = Date.now())),
      retry({
        resetOnSuccess: true,
        delay: (err: unknown, attempt: number) => {
          if (!everConnected && allowFallback) return throwError(() => err);
          const delay = backoffDelay(attempt);
          this.state.set({ kind: 'reconnecting', attempt, retryAt: Date.now() + delay });
          return timer(delay);
        },
      }),
      catchError(() => {
        // Never reached the server: run the identical protocol in a Web Worker instead.
        queueMicrotask(() => this.startSimulated('fallback'));
        return EMPTY;
      }),
    );
    this.sub = session$.subscribe((ev) => this.ingest(ev));
  }

  private ping(): ClientMessage {
    return { v: PROTOCOL_VERSION, type: 'ping', id: ++this.pingId, clientTs: Date.now() };
  }

  private ingest(ev: ServerEvent) {
    this.epsCount++;
    if (ev.type === 'pong') {
      const rtt = Date.now() - ev.clientTs;
      const prev = this.rttMs();
      this.rttMs.set(prev === null ? rtt : Math.round(prev * 0.7 + rtt * 0.3));
    }
    this.eventsSubject.next(ev);
    if (!ANALYTICS.has(ev.type)) return;
    if (ev.type !== 'hello') this.ring.push(ev);
    if (ev.type === 'hello' || (!this.paused() && !this.replaying())) this.displaySubject.next(ev);
  }
}
