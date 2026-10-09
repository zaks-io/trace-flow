/**
 * A Worker invocation keeps at most six outbound calls (R2 included) waiting on response headers
 * and queues the rest, so a wider fan-out only holds more envelopes in memory.
 * https://developers.cloudflare.com/workers/platform/limits/#simultaneous-open-connections
 */
export const STORAGE_CONCURRENCY = 6;

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
