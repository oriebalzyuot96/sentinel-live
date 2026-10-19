import { PROTOCOL_VERSION, type AlertEvent, type AlertRef, type AlertType, type Severity } from '../../shared/protocol';

export const MAX_ALERTS = 150;

export interface AlertRecord extends AlertEvent {
  ackedBy?: string;
  assignee?: string;
}

export interface AlertsState {
  /** Newest first, at most MAX_ALERTS. */
  items: AlertRecord[];
  /** Mute rules as `${cam}|${alertType}`. */
  muted: string[];
  /** Total alerts received (including deduplicated / muted ones). */
  received: number;
}

export const initialAlertsState: AlertsState = { items: [], muted: [], received: 0 };

export type AlertsAction =
  | { type: 'received'; alerts: AlertEvent[] }
  | { type: 'ack'; id: string; by: string }
  | { type: 'ackAll'; by: string }
  | { type: 'workflow'; ref: AlertRef; ts: number; assignee?: string; ackedBy?: string }
  | { type: 'mute'; cam: string; alertType: AlertType }
  | { type: 'unmute'; key: string }
  | { type: 'reset' };

export const muteKey = (cam: string, alertType: AlertType) => `${cam}|${alertType}`;
export const isAcked = (a: AlertRecord) => !!a.ackedBy;
export const toRef = (a: AlertEvent): AlertRef => ({ id: a.id, cam: a.cam, alertType: a.alertType, severity: a.severity });

function insertSorted(items: AlertRecord[], fresh: AlertRecord[]): AlertRecord[] {
  return [...fresh, ...items].sort((a, b) => b.ts - a.ts).slice(0, MAX_ALERTS);
}

/** Pure reducer: never mutates `state`. */
export function alertsReducer(state: AlertsState, action: AlertsAction): AlertsState {
  switch (action.type) {
    case 'received': {
      if (!action.alerts.length) return state;
      const muted = new Set(state.muted);
      const known = new Set(state.items.map((a) => a.id));
      const fresh: AlertRecord[] = [];
      for (const a of action.alerts) {
        if (known.has(a.id) || muted.has(muteKey(a.cam, a.alertType))) continue;
        known.add(a.id);
        fresh.push({ ...a });
      }
      const received = state.received + action.alerts.length;
      if (!fresh.length) return { ...state, received };
      return { ...state, items: insertSorted(state.items, fresh), received };
    }
    case 'ack': {
      let changed = false;
      const items = state.items.map((a) => {
        if (a.id !== action.id || a.ackedBy) return a;
        changed = true;
        return { ...a, ackedBy: action.by };
      });
      return changed ? { ...state, items } : state;
    }
    case 'ackAll':
      if (state.items.every(isAcked)) return state;
      return { ...state, items: state.items.map((a) => (a.ackedBy ? a : { ...a, ackedBy: action.by })) };
    case 'workflow': {
      const patch: Partial<AlertRecord> = {};
      if (action.assignee !== undefined) patch.assignee = action.assignee;
      if (action.ackedBy !== undefined) patch.ackedBy = action.ackedBy;
      const idx = state.items.findIndex((a) => a.id === action.ref.id);
      if (idx >= 0) {
        const items = state.items.slice();
        items[idx] = { ...items[idx], ...patch };
        return { ...state, items };
      }
      // Unknown alert (e.g. replica with a different history): materialise it from the ref.
      const record: AlertRecord = { v: PROTOCOL_VERSION, type: 'alert', ts: action.ts, trackId: '-', ...action.ref, ...patch };
      return { ...state, items: insertSorted(state.items, [record]) };
    }
    case 'mute': {
      const key = muteKey(action.cam, action.alertType);
      if (state.muted.includes(key)) return state;
      return {
        ...state,
        muted: [...state.muted, key],
        items: state.items.filter((a) => muteKey(a.cam, a.alertType) !== key),
      };
    }
    case 'unmute':
      return state.muted.includes(action.key) ? { ...state, muted: state.muted.filter((k) => k !== action.key) } : state;
    case 'reset':
      return initialAlertsState;
  }
}

export interface AlertFilter {
  severities: readonly Severity[];
  types: readonly AlertType[];
  /** Empty = all cameras. */
  cams: readonly string[];
  showAcked: boolean;
  /** Only alerts assigned to this operator id. */
  assignedTo?: string;
}

export const emptyFilter: AlertFilter = { severities: [], types: [], cams: [], showAcked: true };

export function filterAlerts(items: readonly AlertRecord[], f: AlertFilter): AlertRecord[] {
  return items.filter(
    (a) =>
      (f.showAcked || !a.ackedBy) &&
      (!f.severities.length || f.severities.includes(a.severity)) &&
      (!f.types.length || f.types.includes(a.alertType)) &&
      (!f.cams.length || f.cams.includes(a.cam)) &&
      (!f.assignedTo || a.assignee === f.assignedTo),
  );
}

/** Toggle membership of `value` in a readonly list (for filter chips). */
export function toggleIn<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

/**
 * Bucket alerts by severity into `buckets` slots of `bucketMs` ending at `now`
 * (index 0 = oldest). Used by the alerts timeline chart.
 */
export function bucketAlerts(
  items: readonly AlertEvent[],
  now: number,
  buckets: number,
  bucketMs: number,
): Record<Severity, number>[] {
  const out = Array.from({ length: buckets }, () => ({ low: 0, medium: 0, high: 0, critical: 0 }));
  const start = now - buckets * bucketMs;
  for (const a of items) {
    if (a.ts < start || a.ts > now) continue;
    const idx = Math.min(buckets - 1, Math.floor((a.ts - start) / bucketMs));
    out[idx][a.severity]++;
  }
  return out;
}
