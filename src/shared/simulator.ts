/**
 * Deterministic multi-camera scene simulator.
 *
 * It fakes what a video-analytics pipeline would publish: tracked objects per
 * frame, rule-based alerts and per-camera stats. Nothing here looks at real
 * video; positions are synthetic and seeded so tests are reproducible.
 * Runs unchanged in Node (server) and in a Web Worker (demo mode).
 */
import { CAMERAS, SCENE_LAYOUT, type Rect, type SceneLayout } from './cameras';
import { clamp, depthAt, mulberry32, pointInPolygon, segmentsIntersect } from './geometry';
import {
  PROTOCOL_VERSION,
  type AlertEvent,
  type AlertType,
  type CameraInfo,
  type FrameEvent,
  type HelloEvent,
  type ObjectClass,
  type Point,
  type ServerEvent,
  type Severity,
  type StatsEvent,
  type TrackedObject,
} from './protocol';

export interface SimulatorOptions {
  seed?: number;
  cameras?: CameraInfo[];
  /** Frames per second per camera. */
  fps?: number;
  source?: HelloEvent['source'];
  /** Multiplier on the probability of rare behaviours (bag drops, loitering). */
  eventRate?: number;
}

interface Agent {
  id: string;
  cls: ObjectClass;
  /** Foot position (bottom-centre of the box) in normalised coordinates. */
  fx: number;
  fy: number;
  prevFx: number;
  prevFy: number;
  vx: number;
  vy: number;
  tx: number;
  ty: number;
  speed: number;
  /** ms to wait before moving again (loitering / parked). */
  waitMs: number;
  stillMs: number;
  ageMs: number;
  confBias: number;
  ttlMs: number;
  alerted: Set<AlertType>;
}

interface CamState {
  info: CameraInfo;
  layout: SceneLayout;
  agents: Agent[];
  seq: number;
  nextId: number;
  nextAlert: number;
  cooldown: Map<string, number>;
  frames: number;
}

export const MAX_RECENT_ALERTS = 200;

export class Simulator {
  readonly cameras: CameraInfo[];
  private readonly rand: () => number;
  private readonly cams: CamState[];
  private readonly frameIntervalMs: number;
  private readonly source: HelloEvent['source'];
  private readonly eventRate: number;
  private frameAccMs = 0;
  private statsAccMs = 0;
  private clockMs = 0;
  private readonly recent: AlertEvent[] = [];

  constructor(opts: SimulatorOptions = {}) {
    this.cameras = opts.cameras ?? CAMERAS;
    this.rand = mulberry32(opts.seed ?? 42);
    this.frameIntervalMs = 1000 / (opts.fps ?? 10);
    this.source = opts.source ?? 'simulator';
    this.eventRate = opts.eventRate ?? 1;
    this.cams = this.cameras.map((info) => ({
      info,
      layout: SCENE_LAYOUT[info.scene],
      agents: [],
      seq: 0,
      nextId: 1,
      nextAlert: 1,
      cooldown: new Map(),
      frames: 0,
    }));
    for (const cam of this.cams) this.populate(cam, true);
  }

  hello(now: number): HelloEvent {
    return { v: PROTOCOL_VERSION, type: 'hello', ts: now, source: this.source, cameras: this.cameras };
  }

  /** Most recent alerts, newest first (used by the REST endpoint). */
  recentAlerts(limit = 50): AlertEvent[] {
    return this.recent.slice(0, clamp(Math.floor(limit), 0, MAX_RECENT_ALERTS));
  }

  /** Number of live agents (useful for tests / boundedness checks). */
  agentCount(): number {
    return this.cams.reduce((n, c) => n + c.agents.length, 0);
  }

  /**
   * Advance the world by `dtMs` and return the events produced, in order.
   * Frames are emitted on a fixed cadence; stats once per second.
   */
  step(dtMs: number, now: number): ServerEvent[] {
    const out: ServerEvent[] = [];
    const dt = clamp(dtMs, 0, 1000);
    this.clockMs += dt;
    for (const cam of this.cams) {
      this.simulate(cam, dt, now, out);
    }
    this.frameAccMs += dt;
    if (this.frameAccMs >= this.frameIntervalMs) {
      this.frameAccMs %= this.frameIntervalMs;
      for (const cam of this.cams) out.push(this.frame(cam, now));
    }
    this.statsAccMs += dt;
    if (this.statsAccMs >= 1000) {
      this.statsAccMs %= 1000;
      for (const cam of this.cams) out.push(this.stats(cam, now));
    }
    return out;
  }

  // -------------------------------------------------------------------------

  private r(lo: number, hi: number) {
    return lo + (hi - lo) * this.rand();
  }

  private pickRect(rects: Rect[]): Rect {
    return rects[Math.floor(this.rand() * rects.length)];
  }

  private populate(cam: CamState, initial: boolean) {
    const persons = cam.agents.filter((a) => a.cls === 'person').length;
    const vehicles = cam.agents.filter((a) => a.cls === 'vehicle').length;
    for (let i = persons; i < cam.layout.persons; i++) cam.agents.push(this.spawnPerson(cam, initial));
    for (let i = vehicles; i < cam.layout.vehicles; i++) {
      const v = this.spawnVehicle(cam, initial);
      if (v) cam.agents.push(v);
    }
  }

  private newAgent(cam: CamState, cls: ObjectClass, fx: number, fy: number): Agent {
    const prefix = cls === 'person' ? 'P' : cls === 'vehicle' ? 'V' : 'B';
    return {
      id: `${prefix}-${cam.nextId++}`,
      cls,
      fx,
      fy,
      prevFx: fx,
      prevFy: fy,
      vx: 0,
      vy: 0,
      tx: fx,
      ty: fy,
      speed: 0,
      waitMs: 0,
      stillMs: 0,
      ageMs: 0,
      confBias: this.r(-0.06, 0.05),
      ttlMs: this.r(30_000, 90_000),
      alerted: new Set(),
    };
  }

  private spawnPerson(cam: CamState, initial: boolean): Agent {
    const rect = this.pickRect(cam.layout.walk);
    const fy = this.r(rect.y0, rect.y1);
    const fx = initial ? this.r(rect.x0, rect.x1) : this.rand() < 0.5 ? -0.03 : 1.03;
    const a = this.newAgent(cam, 'person', fx, fy);
    a.speed = this.r(0.05, 0.11);
    this.retarget(cam, a);
    return a;
  }

  private spawnVehicle(cam: CamState, initial: boolean): Agent | null {
    if (!cam.layout.lanes.length) return null;
    const lane = cam.layout.lanes[Math.floor(this.rand() * cam.layout.lanes.length)];
    const fx = initial ? this.r(0.1, 0.9) : lane.dir > 0 ? -0.15 : 1.15;
    const a = this.newAgent(cam, 'vehicle', fx, lane.y);
    a.speed = this.r(0.07, 0.16);
    a.tx = lane.dir > 0 ? 1.3 : -0.3;
    a.ty = lane.y;
    a.ttlMs = Infinity;
    return a;
  }

  private retarget(cam: CamState, a: Agent) {
    // Most of the time pick a point on the walkable ground; sometimes walk off-screen.
    if (a.ageMs > a.ttlMs) {
      a.tx = a.fx < 0.5 ? -0.32 : 1.32;
      a.ty = a.fy;
      return;
    }
    const rect = this.pickRect(cam.layout.walk);
    a.tx = this.r(rect.x0, rect.x1);
    a.ty = this.r(rect.y0, rect.y1);
    // Platform: occasionally drift to the edge (rare, yields an intrusion alert).
    if (cam.info.scene === 'platform' && this.rand() < 0.04 * this.eventRate) a.ty = this.r(0.92, 0.97);
    // Rare: wander into a restricted zone.
    if (this.rand() < 0.035 * this.eventRate && cam.info.zones.length) {
      const poly = cam.info.zones[0].polygon;
      const cx = poly.reduce((s, p) => s + p[0], 0) / poly.length;
      const cy = poly.reduce((s, p) => s + p[1], 0) / poly.length;
      a.tx = cx + this.r(-0.03, 0.03);
      a.ty = cy + this.r(-0.02, 0.02);
    }
    // Loiter at the destination for a while.
    a.waitMs = this.rand() < 0.12 * this.eventRate ? this.r(11_000, 20_000) : this.r(0, 2_500);
  }

  private simulate(cam: CamState, dt: number, now: number, out: ServerEvent[]) {
    const s = dt / 1000;
    const dropped: Agent[] = [];
    for (const a of cam.agents) {
      a.ageMs += dt;
      a.prevFx = a.fx;
      a.prevFy = a.fy;
      if (a.cls === 'bag') {
        a.stillMs += dt;
        a.vx = a.vy = 0;
        continue;
      }
      const dx = a.tx - a.fx;
      const dy = a.ty - a.fy;
      const dist = Math.hypot(dx, dy);
      const depth = depthAt(a.fy);
      const v = a.speed * (0.35 + 0.65 * depth);
      if (a.cls === 'vehicle') {
        // Occasionally pause (parking / yielding).
        if (a.waitMs > 0) {
          a.waitMs -= dt;
          a.vx = a.vy = 0;
        } else {
          a.vx = Math.sign(dx) * v;
          a.vy = 0;
          a.fx += a.vx * s;
          if (this.rand() < (0.0006 * dt) / 16) a.waitMs = this.r(3_000, 9_000);
        }
      } else if (dist < 0.01) {
        a.vx = a.vy = 0;
        if (a.waitMs > 0) a.waitMs -= dt;
        else this.retarget(cam, a);
      } else {
        a.vx = (dx / dist) * v;
        a.vy = (dy / dist) * v * 0.6;
        a.fx += a.vx * s;
        a.fy = clamp(a.fy + a.vy * s, 0.42, 0.995);
        // Rare bag drop (abandoned-object scenario).
        if (this.rand() < 0.000003 * this.eventRate * dt && cam.agents.filter((x) => x.cls === 'bag').length < 2) {
          dropped.push(this.newAgent(cam, 'bag', a.fx + 0.01, a.fy));
        }
      }
      a.stillMs = a.vx === 0 && a.vy === 0 ? a.stillMs + dt : 0;
    }
    for (const b of dropped) {
      b.ttlMs = this.r(16_000, 30_000);
      cam.agents.push(b);
    }

    this.evaluateRules(cam, now, out);

    // Despawn: left the scene, or a bag past its lifetime.
    cam.agents = cam.agents.filter((a) => {
      if (a.cls === 'bag') return a.ageMs < a.ttlMs;
      return a.fx > -0.25 && a.fx < 1.25;
    });
    this.populate(cam, false);
  }

  private evaluateRules(cam: CamState, now: number, out: ServerEvent[]) {
    const persons = cam.agents.filter((a) => a.cls === 'person');
    for (const a of cam.agents) {
      if (a.fx < 0 || a.fx > 1) continue;
      const foot: Point = [a.fx, a.fy];
      if (a.cls === 'person') {
        for (const z of cam.info.zones) {
          if (pointInPolygon(foot, z.polygon)) {
            const sev: Severity = cam.info.scene === 'platform' ? 'critical' : 'high';
            this.raise(cam, now, out, 'intrusion', sev, a.id, z.label, 15_000);
          }
        }
        if (a.stillMs > 10_000 && !a.alerted.has('loitering')) {
          a.alerted.add('loitering');
          const inZone = cam.info.zones.some((z) => pointInPolygon(foot, z.polygon));
          this.raise(cam, now, out, 'loitering', inZone ? 'high' : 'medium', a.id, undefined, 0);
        }
        if (a.stillMs === 0) a.alerted.delete('loitering');
      }
      if (a.cls !== 'bag') {
        const prev: Point = [a.prevFx, a.prevFy];
        for (const l of cam.info.lines) {
          if (segmentsIntersect(prev, foot, l.a, l.b)) {
            this.raise(cam, now, out, 'line-crossing', a.cls === 'vehicle' ? 'medium' : 'low', a.id, l.label, 6_000);
          }
        }
      } else if (a.stillMs > 8_000 && !a.alerted.has('abandoned-object')) {
        const owner = persons.some((p) => Math.hypot(p.fx - a.fx, p.fy - a.fy) < 0.1);
        if (!owner) {
          a.alerted.add('abandoned-object');
          this.raise(cam, now, out, 'abandoned-object', 'high', a.id, undefined, 0);
        }
      }
    }
    const visible = persons.filter((p) => p.fx >= 0 && p.fx <= 1).length;
    if (visible >= cam.layout.crowdThreshold) {
      this.raise(cam, now, out, 'crowding', visible >= cam.layout.crowdThreshold + 3 ? 'critical' : 'high', 'group', undefined, 25_000);
    }
  }

  private raise(
    cam: CamState,
    now: number,
    out: ServerEvent[],
    type: AlertType,
    severity: Severity,
    trackId: string,
    zone: string | undefined,
    cooldownMs: number,
  ) {
    const key = `${type}:${trackId}`;
    const until = cam.cooldown.get(key);
    if (until !== undefined && until > this.clockMs) return;
    // Global per-camera/type throttle so a burst does not flood the feed.
    const typeKey = `type:${type}`;
    const typeUntil = cam.cooldown.get(typeKey);
    if (typeUntil !== undefined && typeUntil > this.clockMs) return;
    cam.cooldown.set(typeKey, this.clockMs + 9_000);
    if (cooldownMs > 0) cam.cooldown.set(key, this.clockMs + cooldownMs);
    if (cam.cooldown.size > 256) {
      for (const [k, t] of cam.cooldown) if (t <= this.clockMs) cam.cooldown.delete(k);
    }
    const ev: AlertEvent = {
      v: PROTOCOL_VERSION,
      type: 'alert',
      ts: now,
      id: `${cam.info.id}-a${cam.nextAlert++}`,
      cam: cam.info.id,
      alertType: type,
      severity,
      trackId,
      ...(zone ? { zone } : {}),
    };
    out.push(ev);
    this.recent.unshift(ev);
    if (this.recent.length > MAX_RECENT_ALERTS) this.recent.length = MAX_RECENT_ALERTS;
  }

  private frame(cam: CamState, now: number): FrameEvent {
    cam.frames++;
    const objects: TrackedObject[] = [];
    for (const a of cam.agents) {
      const depth = depthAt(a.fy);
      let h: number;
      let w: number;
      if (a.cls === 'person') {
        h = 0.07 + 0.3 * depth;
        w = h * 0.36;
      } else if (a.cls === 'vehicle') {
        h = 0.07 + 0.2 * depth;
        w = h * 2.3;
      } else {
        h = 0.012 + 0.04 * depth;
        w = h * 1.25;
      }
      const x = a.fx - w / 2;
      const y = a.fy - h;
      if (x + w < 0 || x > 1) continue;
      const conf = clamp(0.58 + 0.36 * depth + a.confBias + this.r(-0.03, 0.03), 0.3, 0.995);
      objects.push({
        id: a.id,
        cls: a.cls,
        bbox: { x: round(x), y: round(y), w: round(w), h: round(h) },
        conf: Math.round(conf * 1000) / 1000,
        vx: round(a.vx),
        vy: round(a.vy),
      });
    }
    // Capture timestamp precedes publication by a simulated inference delay.
    const inference = this.r(18, 42);
    return { v: PROTOCOL_VERSION, type: 'frame', ts: now - inference, cam: cam.info.id, seq: ++cam.seq, objects };
  }

  private stats(cam: CamState, now: number): StatsEvent {
    const counts: Record<ObjectClass, number> = { person: 0, vehicle: 0, bag: 0 };
    for (const a of cam.agents) if (a.fx >= 0 && a.fx <= 1) counts[a.cls]++;
    const fps = Math.min(1000 / this.frameIntervalMs, cam.frames) - this.r(0, 0.6);
    cam.frames = 0;
    return {
      v: PROTOCOL_VERSION,
      type: 'stats',
      ts: now,
      cam: cam.info.id,
      fps: Math.round(fps * 10) / 10,
      counts,
      latencyMs: Math.round(this.r(18, 42)),
    };
  }
}

const round = (n: number) => Math.round(n * 10000) / 10000;
