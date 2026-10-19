import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { Subject, bufferTime, filter, interval } from 'rxjs';
import { OBJECT_CLASSES, SEVERITIES, type AlertEvent, type CameraInfo, type ObjectClass, type ServerEvent, type Severity, type StatsEvent } from '../../shared/protocol';
import { ApiService } from './api.service';
import {
  alertsReducer,
  bucketAlerts,
  emptyFilter,
  filterAlerts,
  initialAlertsState,
  type AlertFilter,
  type AlertsAction,
} from './alerts.reducer';
import { FeedService } from './feed.service';
import { SceneState } from './scene-state';
import { SoundService } from './sound.service';

export interface Kpis {
  objects: number;
  alertsPerMin: number;
  avgConfidence: number;
  latencyMs: number;
  fps: number;
}

export const SERIES_LEN = 60;
export const OCCUPANCY_LEN = 30;
export const OCCUPANCY_STEP_MS = 2_000;
export const TIMELINE_BUCKETS = 30;
export const TIMELINE_BUCKET_MS = 10_000;

const emptySeries = (): Record<ObjectClass, number[]> => ({ person: [], vehicle: [], bag: [] });

/**
 * Dashboard state. Signals for everything the templates read; RxJS for the
 * incoming stream (alert batching with `bufferTime`, sampling with `interval`).
 * High-frequency frame data lives in mutable, bounded SceneState objects that
 * the canvas loop reads directly.
 */
@Injectable({ providedIn: 'root' })
export class AnalyticsStore {
  private readonly feed = inject(FeedService);
  private readonly api = inject(ApiService);
  private readonly sound = inject(SoundService);

  readonly cameras = signal<CameraInfo[]>([]);
  readonly source = signal<'server' | 'simulator' | null>(null);
  readonly alertsState = signal(initialAlertsState);
  readonly filter = signal<AlertFilter>(emptyFilter);
  readonly visibleAlerts = computed(() => filterAlerts(this.alertsState().items, this.filter()));
  readonly kpis = signal<Kpis>({ objects: 0, alertsPerMin: 0, avgConfidence: 0, latencyMs: 0, fps: 0 });
  readonly classSeries = signal<Record<ObjectClass, number[]>>(emptySeries());
  readonly occupancy = signal<Record<string, number[]>>({});
  readonly timeline = signal<Record<Severity, number>[]>(bucketAlerts([], Date.now(), TIMELINE_BUCKETS, TIMELINE_BUCKET_MS));
  readonly camCounts = signal<Record<string, Record<ObjectClass, number> | undefined>>({});
  /** Polite screen-reader announcement for critical alerts. */
  readonly announcement = signal('');
  /** Newest alert per camera (for tile badges). */
  readonly latestByCam = computed(() => {
    const out: Record<string, AlertEvent> = {};
    for (const a of this.alertsState().items) if (!out[a.cam]) out[a.cam] = a;
    return out;
  });

  private readonly scenes = new Map<string, SceneState>();
  private readonly stats = new Map<string, StatsEvent>();
  private readonly alertIn = new Subject<AlertEvent>();
  private latencyEma = 0;
  private started = false;
  private readonly destroyRef = inject(DestroyRef);

  scene(camId: string): SceneState {
    let s = this.scenes.get(camId);
    if (!s) {
      s = new SceneState();
      this.scenes.set(camId, s);
    }
    return s;
  }

  camera(camId: string): CameraInfo | undefined {
    return this.cameras().find((c) => c.id === camId);
  }

  dispatch(action: AlertsAction): void {
    this.alertsState.update((s) => alertsReducer(s, action));
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const subs = [
      this.feed.display$.subscribe((ev) => this.onEvent(ev)),
      // Batch alerts: one signal write per 250 ms instead of one per alert.
      this.alertIn.pipe(bufferTime(250), filter((b) => b.length > 0)).subscribe((batch) => this.onAlerts(batch)),
      interval(500).subscribe(() => this.sampleKpis()),
      interval(1000).subscribe(() => this.sampleSeries()),
      interval(OCCUPANCY_STEP_MS).subscribe(() => this.sampleOccupancy()),
      // REST integration: seed cameras + recent alert history on each live session.
      this.feed.session$.pipe(filter((s) => s === 'live')).subscribe(() => {
        this.api.cameras().subscribe((cams) => cams?.length && this.cameras.set(cams));
        this.api.recentAlerts(50).subscribe((alerts) => alerts?.length && this.dispatch({ type: 'received', alerts }));
      }),
    ];
    this.destroyRef.onDestroy(() => subs.forEach((s) => s.unsubscribe()));
  }

  private onEvent(ev: ServerEvent) {
    switch (ev.type) {
      case 'hello':
        this.cameras.set(ev.cameras);
        this.source.set(ev.source);
        return;
      case 'frame': {
        this.scene(ev.cam).ingest(ev, performance.now());
        if (!this.feed.replaying()) {
          const lat = Math.max(0, Date.now() - ev.ts);
          this.latencyEma = this.latencyEma ? this.latencyEma * 0.95 + lat * 0.05 : lat;
        }
        return;
      }
      case 'stats':
        this.stats.set(ev.cam, ev);
        return;
      case 'alert':
        this.alertIn.next(ev);
        return;
      default:
        return;
    }
  }

  private onAlerts(batch: AlertEvent[]) {
    const muted = new Set(this.alertsState().muted);
    const now = performance.now();
    let top: Severity | null = null;
    for (const a of batch) {
      if (muted.has(`${a.cam}|${a.alertType}`)) continue;
      this.scene(a.cam).flag(a.trackId, now);
      if (!top || SEVERITIES.indexOf(a.severity) > SEVERITIES.indexOf(top)) top = a.severity;
    }
    this.dispatch({ type: 'received', alerts: batch });
    if (!this.feed.replaying() && top && (top === 'high' || top === 'critical')) this.sound.play(top);
    const critical = batch.find((a) => a.severity === 'critical');
    if (critical) this.announcement.set(`${critical.alertType} ${critical.cam} ${critical.trackId}`);
  }

  private sampleKpis() {
    if (this.feed.paused()) return;
    let objects = 0;
    let confSum = 0;
    for (const cam of this.cameras()) {
      const f = this.scenes.get(cam.id)?.frame;
      if (!f) continue;
      objects += f.objects.length;
      for (const o of f.objects) confSum += o.conf;
    }
    const minuteAgo = Date.now() - 60_000;
    const alertsPerMin = this.alertsState().items.filter((a) => a.ts >= minuteAgo).length;
    let fps = 0;
    for (const s of this.stats.values()) fps += s.fps;
    this.kpis.set({
      objects,
      alertsPerMin,
      avgConfidence: objects ? (confSum / objects) * 100 : 0,
      latencyMs: Math.round(this.latencyEma),
      fps: this.stats.size ? fps / this.stats.size : 0,
    });
  }

  private sampleSeries() {
    if (this.feed.paused()) return;
    const totals: Record<ObjectClass, number> = { person: 0, vehicle: 0, bag: 0 };
    const perCam: Record<string, Record<ObjectClass, number>> = {};
    for (const cam of this.cameras()) {
      const c = this.scene(cam.id).counts();
      perCam[cam.id] = c;
      for (const k of OBJECT_CLASSES) totals[k] += c[k];
    }
    this.camCounts.set(perCam);
    this.classSeries.update((s) => {
      const next = emptySeries();
      for (const k of OBJECT_CLASSES) next[k] = [...s[k].slice(-(SERIES_LEN - 1)), totals[k]];
      return next;
    });
    this.timeline.set(bucketAlerts(this.alertsState().items, Date.now(), TIMELINE_BUCKETS, TIMELINE_BUCKET_MS));
  }

  private sampleOccupancy() {
    if (this.feed.paused()) return;
    this.occupancy.update((prev) => {
      const next: Record<string, number[]> = {};
      for (const cam of this.cameras()) {
        const persons = this.scene(cam.id).counts().person;
        next[cam.id] = [...(prev[cam.id] ?? []).slice(-(OCCUPANCY_LEN - 1)), persons];
      }
      return next;
    });
  }
}
