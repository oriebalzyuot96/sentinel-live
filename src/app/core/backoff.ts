export interface BackoffOptions {
  /** First retry delay in ms. */
  baseMs: number;
  /** Upper bound for any delay. */
  maxMs: number;
  /** Growth factor per attempt. */
  factor: number;
  /** 0..1 — fraction of the delay that is randomised ("equal jitter"). */
  jitter: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 1000, maxMs: 15_000, factor: 2, jitter: 0.3 };

/**
 * Exponential backoff with bounded jitter.
 * attempt is 1-based: attempt 1 → ~baseMs, attempt 2 → ~baseMs*factor, …
 */
export function backoffDelay(attempt: number, opts: BackoffOptions = DEFAULT_BACKOFF, random: () => number = Math.random): number {
  const n = Math.max(1, Math.floor(attempt));
  const raw = Math.min(opts.maxMs, opts.baseMs * Math.pow(opts.factor, n - 1));
  const spread = raw * opts.jitter;
  return Math.round(raw - spread + spread * random());
}
