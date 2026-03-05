import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getCached, invalidate, _clearAll, MAX_L1_ENTRIES } from '../cache';

beforeEach(async () => {
  await _clearAll();
});

describe('getCached', () => {
  it('calls fetcher on first access', async () => {
    const fetcher = vi.fn().mockResolvedValue('hello');
    const result = await getCached('key-1', fetcher);
    expect(result).toBe('hello');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('returns cached value on second access without calling fetcher', async () => {
    const fetcher = vi.fn().mockResolvedValue('hello');

    await getCached('key-2', fetcher);
    const result = await getCached('key-2', fetcher);

    expect(result).toBe('hello');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('caches null values (e.g. KV key not found)', async () => {
    const fetcher = vi.fn().mockResolvedValue(null);

    const first = await getCached('key-null', fetcher);
    const second = await getCached('key-null', fetcher);

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('caches objects by value', async () => {
    const obj = { status: 'active', tier: 'pro' };
    const fetcher = vi.fn().mockResolvedValue(obj);

    const first = await getCached('key-obj', fetcher);
    const second = await getCached('key-obj', fetcher);

    expect(first).toEqual(obj);
    expect(second).toEqual(obj);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('_clearAll clears both L1 and L2', async () => {
    const fetcher = vi.fn().mockResolvedValue('from-kv');

    await getCached('key-l2', fetcher);
    expect(fetcher).toHaveBeenCalledOnce();

    await _clearAll();

    // Both layers cleared, so fetcher must be called again
    const result = await getCached('key-l2', fetcher);
    expect(result).toBe('from-kv');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('L1 expired entries fall through to L2', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn().mockResolvedValue('v1');

      // Use a very short TTL — L1 expires after 1ms but L2 min is 1 second
      await getCached('key-ttl', fetcher, 1);

      // Advance past L1 expiry
      vi.advanceTimersByTime(10);

      // L1 expired, should fall through to L2 which still has the value
      const result = await getCached('key-ttl', fetcher, 1);
      expect(result).toBe('v1');
      // Fetcher should NOT be called again because L2 still has the value
      expect(fetcher).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses different cache entries for different keys', async () => {
    const fetcherA = vi.fn().mockResolvedValue('a');
    const fetcherB = vi.fn().mockResolvedValue('b');

    const resultA = await getCached('key-a', fetcherA);
    const resultB = await getCached('key-b', fetcherB);

    expect(resultA).toBe('a');
    expect(resultB).toBe('b');
  });
});

describe('invalidate', () => {
  it('removes entry from cache so fetcher is called again', async () => {
    const fetcher = vi.fn().mockResolvedValue('original');

    await getCached('key-inv', fetcher);
    expect(fetcher).toHaveBeenCalledOnce();

    await invalidate('key-inv');

    fetcher.mockResolvedValue('updated');
    const result = await getCached('key-inv', fetcher);
    expect(result).toBe('updated');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe('L1 eviction at MAX_L1_ENTRIES', () => {
  it('evicts oldest entries when L1 is full', async () => {
    // Fill L1 to capacity
    for (let i = 0; i < MAX_L1_ENTRIES; i++) {
      const fetcher = vi.fn().mockResolvedValue(`val-${i}`);
      await getCached(`evict-${i}`, fetcher);
    }

    // Add one more — should evict the least recently used (evict-0)
    const newFetcher = vi.fn().mockResolvedValue('new-val');
    await getCached('evict-new', newFetcher);
    expect(newFetcher).toHaveBeenCalledOnce();

    // Clear L2 for evict-0 so only L1 or a fresh fetch can serve it
    await invalidate('evict-0');

    // evict-0 was evicted from L1 and we just cleared L2, so fetcher must be called
    const evictedFetcher = vi.fn().mockResolvedValue('re-fetched');
    const result = await getCached('evict-0', evictedFetcher);
    expect(result).toBe('re-fetched');
    expect(evictedFetcher).toHaveBeenCalledOnce();

    // A key near the end should still be in L1 (not evicted)
    const keptFetcher = vi.fn().mockResolvedValue('should-not-call');
    await getCached(`evict-${MAX_L1_ENTRIES - 1}`, keptFetcher);
    expect(keptFetcher).not.toHaveBeenCalled(); // L1 hit
  });
});

describe('_clearAll', () => {
  it('clears all cached entries', async () => {
    const fetcher1 = vi.fn().mockResolvedValue('v1');
    const fetcher2 = vi.fn().mockResolvedValue('v2');

    await getCached('key-c1', fetcher1);
    await getCached('key-c2', fetcher2);

    await _clearAll();

    fetcher1.mockResolvedValue('v1-new');
    fetcher2.mockResolvedValue('v2-new');

    const r1 = await getCached('key-c1', fetcher1);
    const r2 = await getCached('key-c2', fetcher2);

    expect(r1).toBe('v1-new');
    expect(r2).toBe('v2-new');
  });
});
