const DEFAULT_TTL_MS = 60_000;
export const MAX_L1_ENTRIES = 1_000;
const CACHE_URL_PREFIX = 'https://cache.internal/';

interface L1Entry<T> {
  value: T;
  expiry: number;
}

// L1: Module-scope Map persists across requests within the same V8 isolate.
// Zero I/O, zero billing. Evicted when the isolate is recycled.
const l1 = new Map<string, L1Entry<unknown>>();

function l1Get<T>(key: string): T | undefined {
  const entry = l1.get(key) as L1Entry<T> | undefined;
  if (!entry) return undefined;
  if (entry.expiry <= Date.now()) {
    l1.delete(key);
    return undefined;
  }
  return entry.value;
}

function l1Set<T>(key: string, value: T, ttlMs: number): void {
  // Prevent unbounded growth — evict expired entries first, then cap size
  if (l1.size >= MAX_L1_ENTRIES) {
    const now = Date.now();
    for (const [k, v] of l1) {
      if (v.expiry <= now) l1.delete(k);
    }
    // Still over limit? Drop oldest entries
    if (l1.size >= MAX_L1_ENTRIES) {
      const overflow = l1.size - MAX_L1_ENTRIES + 1;
      const keys = l1.keys();
      for (let i = 0; i < overflow; i++) {
        const next = keys.next();
        if (!next.done) l1.delete(next.value);
      }
    }
  }
  l1.set(key, { value, expiry: Date.now() + ttlMs });
}

// L2: Cache API (`caches.default`) is free with no per-operation billing.
// Per-colo, ephemeral, survives isolate recycling. Stores Request/Response pairs.
async function l2Get<T>(key: string): Promise<T | undefined> {
  try {
    const cache = caches.default;
    const response = await cache.match(new Request(CACHE_URL_PREFIX + key));
    if (!response) return undefined;
    return (await response.json()) as T;
  } catch {
    return undefined;
  }
}

async function l2Set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
  try {
    const cache = caches.default;
    await cache.put(
      new Request(CACHE_URL_PREFIX + key),
      new Response(JSON.stringify(value), {
        headers: { 'Cache-Control': `max-age=${ttlSeconds}` },
      }),
    );
  } catch {
    // Cache API failures are non-fatal — falls through to KV on next read
  }
}

/**
 * Two-layer cache: L1 (module-scope Map) → L2 (Cache API) → fetcher (KV/DO).
 *
 * L1 is instant and free. L2 is free and survives isolate recycling.
 * Only the fetcher call triggers a billed operation (KV read, DO request, etc).
 */
export async function getCached<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<T> {
  // L1: module-scope Map (zero I/O)
  const l1Hit = l1Get<T>(key);
  if (l1Hit !== undefined) return l1Hit;

  const ttlSeconds = Math.ceil(ttlMs / 1000);

  // L2: Cache API (free, per-colo)
  const l2Hit = await l2Get<T>(key);
  if (l2Hit !== undefined) {
    l1Set(key, l2Hit, ttlMs);
    return l2Hit;
  }

  // Miss — call the actual fetcher (billed operation)
  const value = await fetcher();
  l1Set(key, value, ttlMs);
  await l2Set(key, value, ttlSeconds);
  return value;
}

export async function invalidate(key: string): Promise<void> {
  l1.delete(key);
  try {
    const cache = caches.default;
    await cache.delete(new Request(CACHE_URL_PREFIX + key));
  } catch {
    // Non-fatal
  }
}

/** Visible for testing — clears both cache layers */
export async function _clearAll(): Promise<void> {
  const keys = [...l1.keys()];
  l1.clear();
  try {
    const cache = caches.default;
    await Promise.all(keys.map((k) => cache.delete(new Request(CACHE_URL_PREFIX + k))));
  } catch {
    // Non-fatal in test teardown
  }
}
