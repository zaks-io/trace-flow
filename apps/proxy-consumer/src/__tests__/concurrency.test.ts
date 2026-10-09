import { describe, expect, it } from 'vitest';
import { ByteBudget, forEachConcurrently } from '../concurrency';

describe('forEachConcurrently', () => {
  it('visits every item without exceeding the limit', async () => {
    let active = 0;
    let peak = 0;
    const seen: number[] = [];

    await forEachConcurrently([1, 2, 3, 4, 5, 6, 7], 3, async (item) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      seen.push(item);
      active--;
    });

    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(peak).toBe(3);
  });

  it('rejects a limit that would run nothing', async () => {
    await expect(forEachConcurrently([1], 0, async () => undefined)).rejects.toThrow(
      'Concurrency limit must be a positive integer',
    );
  });
});

describe('ByteBudget', () => {
  it('admits one item larger than the limit when idle', async () => {
    const budget = new ByteBudget(10);
    const release = await budget.acquire(50);
    release();
    await expect(budget.acquire(5)).resolves.toBeTypeOf('function');
  });

  it('holds items that would exceed the limit until room is released', async () => {
    const budget = new ByteBudget(10);
    const first = await budget.acquire(6);
    const small = await budget.acquire(4);
    let admitted = false;
    const waiting = budget.acquire(8).then((release) => {
      admitted = true;
      return release;
    });
    await Promise.resolve();
    first();
    await Promise.resolve();
    expect(admitted).toBe(false);
    small();
    (await waiting)();
    expect(admitted).toBe(true);
  });

  it('releases a lease once, even when called twice or before reserving', async () => {
    const budget = new ByteBudget(10);
    const unreserved = budget.lease();
    unreserved.release();
    const lease = budget.lease();
    await lease.reserve(10);
    lease.release();
    lease.release();
    const other = await budget.acquire(10);
    other();
  });
});
