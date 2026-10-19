import { InjectionToken } from '@angular/core';
import { environment } from '../../environments/environment';

export type FeedMode = 'auto' | 'demo' | 'live';

export interface RuntimeConfig {
  /** auto = try WebSocket, fall back to simulator; demo = simulator only; live = WebSocket only (keeps retrying). */
  feedMode: FeedMode;
  /** Whether demo mode was explicitly forced via `?demo=1`. */
  forcedDemo: boolean;
  wsUrl: string;
  apiBase: string;
  /** Operator explicitly requested with `?op=a|b`. */
  operator: 'op-a' | 'op-b' | null;
}

/**
 * Resolve runtime configuration from the page URL. URLs are resolved against
 * `document.baseURI`, so the app works same-origin under any sub-path
 * (`/sentinel-live/ws`, `/sentinel-live/api/...`).
 */
export function resolveConfig(href: string, baseURI: string, defaultMode: FeedMode = environment.feedMode): RuntimeConfig {
  const url = new URL(href);
  const q = url.searchParams;
  const flag = (k: string) => q.has(k) && q.get(k) !== '0' && q.get(k) !== 'false';
  const forcedDemo = flag('demo');
  const feedMode: FeedMode = forcedDemo ? 'demo' : flag('live') ? 'live' : defaultMode;
  const ws = new URL('ws', baseURI);
  ws.protocol = ws.protocol === 'https:' ? 'wss:' : 'ws:';
  const op = q.get('op')?.toLowerCase();
  return {
    feedMode,
    forcedDemo,
    wsUrl: safeUrl(q.get('ws'), ['ws:', 'wss:']) ?? ws.href,
    apiBase: safeUrl(q.get('api'), ['http:', 'https:']) ?? new URL('api/', baseURI).href,
    operator: op === 'a' || op === 'op-a' ? 'op-a' : op === 'b' || op === 'op-b' ? 'op-b' : null,
  };
}

function safeUrl(raw: string | null, protocols: string[]): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (!protocols.includes(u.protocol)) return null;
    if (u.protocol.startsWith('http') && !u.pathname.endsWith('/')) u.pathname += '/';
    return u.href;
  } catch {
    return null;
  }
}

export const RUNTIME_CONFIG = new InjectionToken<RuntimeConfig>('RUNTIME_CONFIG', {
  providedIn: 'root',
  factory: () => resolveConfig(location.href, document.baseURI),
});
