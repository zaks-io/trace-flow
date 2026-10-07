import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@trace-flow/logging';
import { sweepTraceDeliveries } from '../delivery';

const logger = { error: vi.fn() } as unknown as Logger;
const throttle = new Error(
  'list: Reduce your concurrent request rate for the same object. (10058)',
);
const oldObject = (key: string) => ({ key, uploaded: new Date(1) });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('trace delivery sweep throttling', () => {
  it('retries the throttled page with backoff without enqueueing earlier pages twice', async () => {
    vi.useFakeTimers();
    const list = vi
      .fn()
      .mockResolvedValueOnce({ objects: [oldObject('first')], truncated: true, cursor: 'next' })
      .mockRejectedValueOnce(throttle)
      .mockRejectedValueOnce(throttle)
      .mockResolvedValueOnce({ objects: [oldObject('second')], truncated: false });
    const queue = { send: vi.fn().mockResolvedValue(undefined) };
    const sweep = sweepTraceDeliveries(
      { list } as unknown as R2Bucket,
      queue as never,
      logger,
      'prod',
      600_001,
    );

    await vi.advanceTimersByTimeAsync(999);
    expect(list).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(251);
    expect(list).toHaveBeenCalledTimes(3);
    await vi.runAllTimersAsync();

    await expect(sweep).resolves.toBe(2);
    expect(queue.send.mock.calls).toEqual([
      [{ type: 'delivery', key: 'first' }],
      [{ type: 'delivery', key: 'second' }],
    ]);
    for (const [options] of list.mock.calls.slice(1)) {
      expect(options).toEqual({ prefix: 'trace-deliveries/prod-', limit: 1_000, cursor: 'next' });
    }
  });

  it('fails after bounded retries so persistent throttling remains visible', async () => {
    vi.useFakeTimers();
    const list = vi.fn().mockRejectedValue(throttle);
    const queue = { send: vi.fn() };
    const result = expect(
      sweepTraceDeliveries({ list } as unknown as R2Bucket, queue as never, logger, 'prod'),
    ).rejects.toBe(throttle);

    await vi.runAllTimersAsync();
    await result;
    expect(list).toHaveBeenCalledTimes(4);
    expect(queue.send).not.toHaveBeenCalled();
  });

  it('propagates other list failures immediately', async () => {
    const error = new Error('list: Permission denied. (10014)');
    const list = vi.fn().mockRejectedValue(error);
    const queue = { send: vi.fn() };

    await expect(
      sweepTraceDeliveries({ list } as unknown as R2Bucket, queue as never, logger, 'prod'),
    ).rejects.toBe(error);
    expect(list).toHaveBeenCalledOnce();
    expect(queue.send).not.toHaveBeenCalled();
  });
});
