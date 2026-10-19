import { depthAt, pointInPolygon, segmentsIntersect } from './geometry';
import { validateServerEvent, type AlertEvent, type FrameEvent, type ServerEvent, type StatsEvent } from './protocol';
import { MAX_RECENT_ALERTS, Simulator } from './simulator';

function run(sim: Simulator, seconds: number, start = 1_000_000): ServerEvent[] {
  const out: ServerEvent[] = [];
  for (let t = 0; t < seconds * 10; t++) out.push(...sim.step(100, start + t * 100));
  return out;
}

describe('geometry', () => {
  it('point in polygon', () => {
    const sq = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ] as const;
    expect(pointInPolygon([0.5, 0.5], sq)).toBe(true);
    expect(pointInPolygon([1.5, 0.5], sq)).toBe(false);
  });

  it('segment intersection', () => {
    expect(segmentsIntersect([0, 0], [1, 1], [0, 1], [1, 0])).toBe(true);
    expect(segmentsIntersect([0, 0], [1, 0], [0, 1], [1, 1])).toBe(false);
  });

  it('depth grows towards the bottom of the frame', () => {
    expect(depthAt(0.5)).toBeLessThan(depthAt(0.9));
    expect(depthAt(0)).toBeGreaterThan(0);
  });
});

describe('Simulator', () => {
  it('is deterministic for a given seed', () => {
    const a = run(new Simulator({ seed: 7 }), 5);
    const b = run(new Simulator({ seed: 7 }), 5);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('emits frames at the configured fps and stats once per second per camera', () => {
    const sim = new Simulator({ seed: 1, fps: 10 });
    const events = run(sim, 3);
    const frames = events.filter((e): e is FrameEvent => e.type === 'frame');
    const stats = events.filter((e): e is StatsEvent => e.type === 'stats');
    expect(frames.length).toBe(sim.cameras.length * 30);
    expect(stats.length).toBe(sim.cameras.length * 3);
  });

  it('only produces events that pass protocol validation', () => {
    const events = run(new Simulator({ seed: 3 }), 20);
    for (const e of events) expect(validateServerEvent(JSON.parse(JSON.stringify(e))).ok).toBe(true);
  });

  it('keeps boxes roughly inside the frame with sane confidences', () => {
    const frames = run(new Simulator({ seed: 4 }), 10).filter((e): e is FrameEvent => e.type === 'frame');
    for (const f of frames) {
      for (const o of f.objects) {
        expect(o.bbox.y).toBeGreaterThanOrEqual(0);
        expect(o.bbox.y + o.bbox.h).toBeLessThanOrEqual(1.01);
        expect(o.conf).toBeGreaterThan(0.29);
        expect(o.conf).toBeLessThan(1);
      }
    }
  });

  it('raises alerts of several types over a few simulated minutes', () => {
    const sim = new Simulator({ seed: 11, eventRate: 2 });
    const alerts = run(sim, 240).filter((e): e is AlertEvent => e.type === 'alert');
    expect(alerts.length).toBeGreaterThan(10);
    const types = new Set(alerts.map((a) => a.alertType));
    expect(types.size).toBeGreaterThanOrEqual(3);
    expect(new Set(alerts.map((a) => a.id)).size).toBe(alerts.length);
  });

  it('stays bounded over a long run (agents and alert history)', () => {
    const sim = new Simulator({ seed: 5, eventRate: 3 });
    run(sim, 600);
    expect(sim.agentCount()).toBeLessThan(sim.cameras.length * 20);
    expect(sim.recentAlerts(10_000).length).toBeLessThanOrEqual(MAX_RECENT_ALERTS);
    expect(sim.recentAlerts(5).length).toBeLessThanOrEqual(5);
  });

  it('clamps huge time steps', () => {
    const sim = new Simulator({ seed: 9 });
    expect(() => sim.step(60_000, 1)).not.toThrow();
  });
});
