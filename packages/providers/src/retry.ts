import { setTimeout as sleep } from 'node:timers/promises';
import { HiveError } from '@hive/shared';

/** A failed provider call, with what is needed to decide whether to try again. */
export class ProviderError extends HiveError {
  constructor(
    message: string,
    /** HTTP status; null when the provider could not be reached at all. */
    readonly status: number | null,
    /** What the provider asked for in `Retry-After`, when it did. */
    readonly retryAfterMs: number | null = null,
  ) {
    super('PROVIDER', message);
  }
}

/** Waits between attempts when the provider gives no `Retry-After`; the last one repeats. */
const BACKOFF_MS = [15_000, 30_000, 60_000, 120_000];
const MAX_RETRY_AFTER_MS = 15 * 60_000;

/** `Retry-After` is either seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, MAX_RETRY_AFTER_MS) : null;
}

/**
 * How long to wait before calling again, or null when another try would not help. Rate limits,
 * server errors, timeouts and unreachable providers pass; bad requests and auth errors do not.
 */
export function retryDelay(error: unknown, attempt: number): number | null {
  const backoff = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;
  if (error instanceof ProviderError) {
    const { status } = error;
    if (status === null || status === 408 || status === 429 || status >= 500)
      return error.retryAfterMs ?? backoff;
    return null;
  }
  if (error instanceof HiveError && error.code === 'TIMEOUT') return backoff;
  return null;
}

export interface RetryNotice {
  /** The attempt about to be made, from 2. */
  attempt: number;
  delayMs: number;
  error: unknown;
}

/**
 * Calls `call` until it succeeds, waiting out passing provider failures. It gives up on errors a
 * retry cannot fix, after `maxAttempts`, or when `signal` aborts (a task's own time limit).
 */
export async function withRetries<T>(
  call: () => Promise<T>,
  options: {
    signal?: AbortSignal;
    maxAttempts?: number;
    onRetry?: (notice: RetryNotice) => void;
  } = {},
): Promise<T> {
  const { signal, maxAttempts = Infinity, onRetry } = options;
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      const delayMs = retryDelay(error, attempt - 1);
      if (delayMs === null || attempt >= maxAttempts || signal?.aborted) throw error;
      onRetry?.({ attempt: attempt + 1, delayMs, error });
      await sleep(delayMs, undefined, { signal });
    }
  }
}
