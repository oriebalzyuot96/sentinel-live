import type { FrameEvent, ObjectClass } from '../../shared/protocol';

export const TRAIL_LEN = 24;
export const HEAT_W = 48;
export const HEAT_H = 27;
/** Per-frame heat decay (10 fps → half-life ≈ 23 s). */
export const HEAT_DECAY = 0.997;
/** Drop a trail when its track has been missing this long. */
export const TRAIL_TTL_MS = 1_500;
export const FLAG_MS = 8_000;

export interface Trail {
  xs: Float32Array;
  ys: Float32Array;
  /** Number of valid points (≤ TRAIL_LEN). */
  len: number;
  /** Index where the next point will be written. */
  head: number;
  lastSeen: number;
}

/**
 * Mutable per-camera render state, updated on every frame and read by the
 * canvas render loop. Deliberately not a signal: 60 updates/s would only
 * create change-detection churn. All collections are bounded.
 */
export class SceneState {
  frame: FrameEvent | null = null;
  /** performance.now() when `frame` arrived (for motion interpolation). */
  receivedAt = 0;
  readonly trails = new Map<string, Trail>();
  readonly heat = new Float32Array(HEAT_W * HEAT_H);
  heatPeak = 0;
  /** trackId → performance.now() until which it is highlighted (active alert). */
  readonly flagged = new Map<string, number>();

  ingest(frame: FrameEvent, now: number): void {
    this.frame = frame;
    this.receivedAt = now;
    let peak = 0;
    for (let i = 0; i < this.heat.length; i++) {
      const v = this.heat[i] * HEAT_DECAY;
      this.heat[i] = v;
      if (v > peak) peak = v;
    }
    for (const o of frame.objects) {
      const fx = o.bbox.x + o.bbox.w / 2;
      const fy = o.bbox.y + o.bbox.h;
      let t = this.trails.get(o.id);
      if (!t) {
        t = { xs: new Float32Array(TRAIL_LEN), ys: new Float32Array(TRAIL_LEN), len: 0, head: 0, lastSeen: now };
        this.trails.set(o.id, t);
      }
      t.xs[t.head] = fx;
      t.ys[t.head] = fy;
      t.head = (t.head + 1) % TRAIL_LEN;
      t.len = Math.min(TRAIL_LEN, t.len + 1);
      t.lastSeen = now;
      if (fx >= 0 && fx < 1 && fy >= 0 && fy < 1) {
        const idx = Math.floor(fy * HEAT_H) * HEAT_W + Math.floor(fx * HEAT_W);
        const v = this.heat[idx] + (o.cls === 'person' ? 1 : 0.5);
        this.heat[idx] = v;
        if (v > peak) peak = v;
      }
    }
    this.heatPeak = peak;
    for (const [id, t] of this.trails) if (now - t.lastSeen > TRAIL_TTL_MS) this.trails.delete(id);
    for (const [id, until] of this.flagged) if (until < now) this.flagged.delete(id);
  }

  flag(trackId: string, now: number): void {
    this.flagged.set(trackId, now + FLAG_MS);
    if (this.flagged.size > 64) this.flagged.delete(this.flagged.keys().next().value as string);
  }

  counts(): Record<ObjectClass, number> {
    const c: Record<ObjectClass, number> = { person: 0, vehicle: 0, bag: 0 };
    for (const o of this.frame?.objects ?? []) c[o.cls]++;
    return c;
  }

  /** Trail points oldest → newest. */
  static points(t: Trail): [number, number][] {
    const out: [number, number][] = [];
    for (let i = 0; i < t.len; i++) {
      const j = (t.head - t.len + i + TRAIL_LEN) % TRAIL_LEN;
      out.push([t.xs[j], t.ys[j]]);
    }
    return out;
  }
}
