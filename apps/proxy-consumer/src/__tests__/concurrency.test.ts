import { describe, expect, it } from 'vitest';
import { forEachConcurrently } from '../concurrency';

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
