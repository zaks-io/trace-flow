/**
 * A Worker invocation keeps at most six outbound calls (R2 included) waiting on response headers
 * and queues the rest, so a wider fan-out only holds more envelopes in memory.
 * https://developers.cloudflare.com/workers/platform/limits/#simultaneous-open-connections
 */
export const STORAGE_CONCURRENCY = 6;

/**
 * Stored envelope bytes loaded at once. A loaded envelope peaks near three times its stored size
 * (read text, parsed object, re-serialized body copy), and a Worker isolate has 128 MiB. Six
 * near-limit captures in one batch would otherwise exceed it.
 * https://developers.cloudflare.com/workers/platform/limits/#memory
 */
export const ENVELOPE_BYTES_IN_FLIGHT = 24 * 1024 * 1024;

/** Runs `work` over `items` with at most `limit` calls in flight. `work` handles its own errors. */
export async function forEachConcurrently<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error(`Concurrency limit must be a positive integer, got ${limit}`);
  }
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      await work(items[next++]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

/**
 * Bounds the bytes held by concurrent work. An idle budget always admits one item, so a single
 * envelope larger than the limit still runs alone, as it did before envelopes loaded in parallel.
 */
export class ByteBudget {
  private held = 0;
  private waiters: (() => void)[] = [];

  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error(`Byte budget must be a positive integer, got ${limit}`);
    }
  }

  /** A per-item handle: `reserve` waits for room once the size is known; `release` is idempotent. */
  lease(): { reserve: (bytes: number) => Promise<void>; release: () => void } {
    let release = (): void => undefined;
    return {
      reserve: async (bytes) => {
        release = await this.acquire(bytes);
      },
      release: () => release(),
    };
  }

  /** Resolves once `bytes` fit, returning an idempotent release. */
  async acquire(bytes: number): Promise<() => void> {
    while (this.held > 0 && this.held + bytes > this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.held += bytes;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.held -= bytes;
      for (const wake of this.waiters.splice(0)) wake();
    };
  }
}
