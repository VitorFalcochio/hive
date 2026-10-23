import { setTimeout as sleep } from 'node:timers/promises';
import { ProviderError } from './retry';
import type { ChatClient, ChatRequest, ChatResponse } from './types';

/** Calls one provider takes at once before the rest wait their turn. */
const MAX_IN_FLIGHT = 4;
/** How long everyone holds off after a rate limit, when the provider does not say. */
const DEFAULT_PAUSE_MS = 20_000;
/** Successful calls in a row before one more may go at once again. */
const SUCCESSES_TO_GROW = 8;

/**
 * Every agent and soldier using one provider shares its rate limit, so they share this gate:
 * a few calls at a time, the rest queued instead of all hitting the limit at once. A 429 pauses
 * the whole provider and halves how many calls go at once; steady successes bring it back up.
 */
export class ProviderGate {
  private inFlight = 0;
  private limit: number;
  private pausedUntil = 0;
  private successes = 0;
  private readonly waiters = new Set<() => void>();

  constructor(
    private readonly max = MAX_IN_FLIGHT,
    private readonly now: () => number = Date.now,
  ) {
    this.limit = max;
  }

  /** How many calls may go at once right now; lower after rate limits. */
  get capacity(): number {
    return this.limit;
  }

  async run<T>(call: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      const value = await call();
      this.succeeded();
      return value;
    } catch (error) {
      if (error instanceof ProviderError && error.status === 429)
        this.rateLimited(error.retryAfterMs);
      throw error;
    } finally {
      this.release();
    }
  }

  private async acquire(signal?: AbortSignal): Promise<void> {
    for (;;) {
      signal?.throwIfAborted();
      const paused = this.pausedUntil - this.now();
      if (paused > 0) {
        await sleep(paused, undefined, { signal });
        continue;
      }
      if (this.inFlight < this.limit) {
        this.inFlight++;
        return;
      }
      await this.turn(signal);
    }
  }

  /** Resolves when a call ends and a place may have opened up. */
  private turn(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const wake = () => {
        signal?.removeEventListener('abort', abort);
        resolve();
      };
      const abort = () => {
        this.waiters.delete(wake);
        reject(signal!.reason);
      };
      this.waiters.add(wake);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  private release() {
    this.inFlight--;
    const next = this.waiters.values().next();
    if (!next.done) {
      this.waiters.delete(next.value);
      next.value();
    }
  }

  private succeeded() {
    if (this.limit >= this.max) return;
    if (++this.successes < SUCCESSES_TO_GROW) return;
    this.successes = 0;
    this.limit++;
  }

  private rateLimited(retryAfterMs: number | null) {
    this.successes = 0;
    this.limit = Math.max(1, Math.floor(this.limit / 2));
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + (retryAfterMs ?? DEFAULT_PAUSE_MS));
  }
}

/** A client whose calls go through a gate shared with every other user of the same provider. */
export class GatedClient implements ChatClient {
  constructor(
    private readonly inner: ChatClient,
    private readonly gate: ProviderGate,
  ) {}

  chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    return this.gate.run(() => this.inner.chat(request, signal), signal);
  }
}
