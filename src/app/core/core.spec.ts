import { PROTOCOL_VERSION as v, type AlertEvent, type FrameEvent } from '../../shared/protocol';
import { MAX_ALERTS, alertsReducer, bucketAlerts, filterAlerts, initialAlertsState, emptyFilter, toggleIn } from './alerts.reducer';
import { DEFAULT_BACKOFF, backoffDelay } from './backoff';
import { resolveConfig } from './config';
import { RingBuffer } from './ring-buffer';
import { SceneState, TRAIL_LEN, TRAIL_TTL_MS } from './scene-state';
import { stackBars } from '../ui/charts/analytics-panel';
import { sparkPath } from '../ui/charts/sparkline';

const alert = (id: string, ts: number, extra: Partial<AlertEvent> = {}): AlertEvent => ({
  v,
  type: 'alert',
  ts,
  id,
  cam: 'cam-01',
  alertType: 'intrusion',
  severity: 'high',
  trackId: 'P-1',
  ...extra,
});

describe('backoffDelay', () => {
  const noJitter = { ...DEFAULT_BACKOFF, jitter: 0 };

  it('grows exponentially and caps at maxMs', () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => backoffDelay(n, noJitter))).toEqual([1000, 2000, 4000, 8000, 15000, 15000]);
  });

  it('keeps jitter within bounds', () => {
    for (let n = 1; n < 8; n++) {
      const raw = Math.min(DEFAULT_BACKOFF.maxMs, 1000 * 2 ** (n - 1));
      expect(backoffDelay(n, DEFAULT_BACKOFF, () => 0)).toBe(Math.round(raw * 0.7));
      expect(backoffDelay(n, DEFAULT_BACKOFF, () => 0.999999)).toBeLessThanOrEqual(raw);
    }
  });

  it('treats attempts below 1 as the first attempt', () => {
    expect(backoffDelay(0, noJitter)).toBe(1000);
    expect(backoffDelay(-3, noJitter)).toBe(1000);
  });
});

describe('RingBuffer', () => {
  it('keeps the newest `capacity` items in order', () => {
    const rb = new RingBuffer<number>(3);
    [1, 2, 3, 4, 5].forEach((n) => rb.push(n));
    expect(rb.size).toBe(3);
    expect(rb.toArray()).toEqual([3, 4, 5]);
    expect(rb.last()).toBe(5);
  });

  it('takes the matching tail', () => {
    const rb = new RingBuffer<number>(5);
    [1, 5, 2, 6, 7].forEach((n) => rb.push(n));
    expect(rb.takeLastWhile((n) => n > 4)).toEqual([6, 7]);
    rb.clear();
    expect(rb.toArray()).toEqual([]);
  });

  it('rejects invalid capacity', () => {
    expect(() => new RingBuffer(0)).toThrow(RangeError);
  });
});

describe('alertsReducer', () => {
  it('adds newest first, dedupes by id and bounds the list', () => {
    let s = alertsReducer(initialAlertsState, { type: 'received', alerts: [alert('a', 1), alert('b', 3), alert('a', 1)] });
    expect(s.items.map((a) => a.id)).toEqual(['b', 'a']);
    expect(s.received).toBe(3);
    const many = Array.from({ length: MAX_ALERTS + 20 }, (_, i) => alert(`x${i}`, 100 + i));
    s = alertsReducer(s, { type: 'received', alerts: many });
    expect(s.items).toHaveLength(MAX_ALERTS);
    expect(s.items[0].id).toBe(`x${MAX_ALERTS + 19}`);
  });

  it('does not mutate the previous state', () => {
    const s0 = alertsReducer(initialAlertsState, { type: 'received', alerts: [alert('a', 1)] });
    const frozen = JSON.stringify(s0);
    alertsReducer(s0, { type: 'ack', id: 'a', by: 'op-a' });
    expect(JSON.stringify(s0)).toBe(frozen);
  });

  it('acknowledges one or all alerts', () => {
    let s = alertsReducer(initialAlertsState, { type: 'received', alerts: [alert('a', 1), alert('b', 2)] });
    s = alertsReducer(s, { type: 'ack', id: 'a', by: 'op-a' });
    expect(s.items.find((a) => a.id === 'a')?.ackedBy).toBe('op-a');
    const same = alertsReducer(s, { type: 'ack', id: 'a', by: 'op-b' });
    expect(same).toBe(s);
    s = alertsReducer(s, { type: 'ackAll', by: 'op-b' });
    expect(s.items.every((a) => a.ackedBy)).toBe(true);
  });

  it('applies workflow updates and materialises unknown alerts', () => {
    let s = alertsReducer(initialAlertsState, { type: 'received', alerts: [alert('a', 1)] });
    s = alertsReducer(s, { type: 'workflow', ref: { id: 'a', cam: 'cam-01', alertType: 'intrusion', severity: 'high' }, ts: 1, assignee: 'op-b' });
    expect(s.items[0].assignee).toBe('op-b');
    s = alertsReducer(s, { type: 'workflow', ref: { id: 'zz', cam: 'cam-02', alertType: 'crowding', severity: 'critical' }, ts: 9, ackedBy: 'op-b' });
    expect(s.items[0]).toMatchObject({ id: 'zz', ackedBy: 'op-b', cam: 'cam-02' });
  });

  it('mutes a camera/type pair (dropping existing and future alerts) and unmutes', () => {
    let s = alertsReducer(initialAlertsState, { type: 'received', alerts: [alert('a', 1), alert('b', 2, { alertType: 'loitering' })] });
    s = alertsReducer(s, { type: 'mute', cam: 'cam-01', alertType: 'intrusion' });
    expect(s.items.map((a) => a.id)).toEqual(['b']);
    s = alertsReducer(s, { type: 'received', alerts: [alert('c', 3)] });
    expect(s.items.map((a) => a.id)).toEqual(['b']);
    s = alertsReducer(s, { type: 'unmute', key: 'cam-01|intrusion' });
    s = alertsReducer(s, { type: 'received', alerts: [alert('d', 4)] });
    expect(s.items[0].id).toBe('d');
  });

  it('filters by severity, type, camera, ack state and assignee', () => {
    const items = [
      { ...alert('a', 1), ackedBy: 'op-a' },
      alert('b', 2, { severity: 'low', cam: 'cam-02' }),
      { ...alert('c', 3, { alertType: 'crowding' }), assignee: 'op-b' },
    ];
    expect(filterAlerts(items, { ...emptyFilter, severities: ['low'] }).map((a) => a.id)).toEqual(['b']);
    expect(filterAlerts(items, { ...emptyFilter, types: ['crowding'] }).map((a) => a.id)).toEqual(['c']);
    expect(filterAlerts(items, { ...emptyFilter, cams: ['cam-02'] }).map((a) => a.id)).toEqual(['b']);
    expect(filterAlerts(items, { ...emptyFilter, showAcked: false }).map((a) => a.id)).toEqual(['b', 'c']);
    expect(filterAlerts(items, { ...emptyFilter, assignedTo: 'op-b' }).map((a) => a.id)).toEqual(['c']);
    expect(toggleIn(['a'], 'a')).toEqual([]);
    expect(toggleIn(['a'], 'b')).toEqual(['a', 'b']);
  });

  it('buckets alerts for the timeline', () => {
    const now = 100_000;
    const b = bucketAlerts([alert('a', now - 5_000), alert('b', now - 95_000, { severity: 'low' }), alert('c', now - 500_000)], now, 10, 10_000);
    expect(b).toHaveLength(10);
    expect(b[9].high).toBe(1);
    expect(b[0].low).toBe(1);
    expect(b.reduce((n, x) => n + x.low + x.medium + x.high + x.critical, 0)).toBe(2);
  });
});

describe('SceneState', () => {
  const frame = (seq: number, ids: string[]): FrameEvent => ({
    v,
    type: 'frame',
    ts: seq,
    cam: 'cam-01',
    seq,
    objects: ids.map((id, i) => ({ id, cls: 'person', bbox: { x: 0.1 * i + seq * 0.001, y: 0.5, w: 0.05, h: 0.2 }, conf: 0.9, vx: 0, vy: 0 })),
  });

  it('keeps trails bounded and drops stale tracks', () => {
    const s = new SceneState();
    for (let i = 0; i < 100; i++) s.ingest(frame(i, ['P-1', 'P-2']), i * 100);
    expect(s.trails.get('P-1')?.len).toBe(TRAIL_LEN);
    s.ingest(frame(200, ['P-3']), 100 * 100 + TRAIL_TTL_MS + 1);
    expect([...s.trails.keys()]).toEqual(['P-3']);
    expect(SceneState.points(s.trails.get('P-3')!)).toHaveLength(1);
  });

  it('accumulates and decays heat', () => {
    const s = new SceneState();
    for (let i = 0; i < 10; i++) s.ingest(frame(i, ['P-1']), i);
    const peak = s.heatPeak;
    expect(peak).toBeGreaterThan(5);
    for (let i = 0; i < 500; i++) s.ingest(frame(i, []), 2000 + i);
    expect(s.heatPeak).toBeLessThan(peak);
  });

  it('flags tracks for a limited time', () => {
    const s = new SceneState();
    s.flag('P-1', 0);
    expect(s.flagged.has('P-1')).toBe(true);
    s.ingest(frame(1, []), 60_000);
    expect(s.flagged.has('P-1')).toBe(false);
  });
});

describe('resolveConfig', () => {
  const base = 'https://example.test/sentinel-live/';
  it('derives same-origin ws and api urls under the base path', () => {
    const c = resolveConfig(`${base}`, base, 'auto');
    expect(c.wsUrl).toBe('wss://example.test/sentinel-live/ws');
    expect(c.apiBase).toBe('https://example.test/sentinel-live/api/');
    expect(c.feedMode).toBe('auto');
  });

  it('honours ?demo=1, ?live=1, ?op= and overrides', () => {
    expect(resolveConfig(`${base}?demo=1`, base, 'auto')).toMatchObject({ feedMode: 'demo', forcedDemo: true });
    expect(resolveConfig(`${base}?live=1`, base, 'demo').feedMode).toBe('live');
    expect(resolveConfig(`${base}?op=b`, base).operator).toBe('op-b');
    expect(resolveConfig(`${base}?ws=ws://h:1/ws`, base).wsUrl).toBe('ws://h:1/ws');
    expect(resolveConfig(`${base}?ws=javascript:alert(1)`, base).wsUrl).toBe('wss://example.test/sentinel-live/ws');
  });
});

describe('chart helpers', () => {
  it('builds sparkline paths right-aligned to capacity', () => {
    expect(sparkPath([1], 100, 20, 10).line).toBe('');
    const p = sparkPath([0, 10], 100, 20, 2);
    expect(p.line.startsWith('M0.0 18.0')).toBe(true);
    expect(p.line).toContain('L100.0 2.0');
    expect(p.area.endsWith('Z')).toBe(true);
  });

  it('stacks severity segments', () => {
    const { bars, max } = stackBars(
      [
        { low: 1, medium: 0, high: 1, critical: 0 },
        { low: 0, medium: 0, high: 0, critical: 0 },
      ],
      100,
      8,
      2,
    );
    expect(max).toBe(2);
    expect(bars[0].segments.map((s) => s.sev)).toEqual(['low', 'high']);
    expect(bars[1].x).toBe(10);
    expect(bars[1].segments).toEqual([]);
  });
});
