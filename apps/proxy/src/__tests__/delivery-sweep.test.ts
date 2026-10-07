import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@trace-flow/logging';
import { createSweepMetrics, sweepTraceDeliveries } from '../delivery-sweep';

const logger = { error: vi.fn() } as unknown as Logger;
const throttle = new Error(
  'list: Reduce your concurrent request rate for the same object. (10058)',
);
const oldObject = (key: string) => ({ key, uploaded: new Date(1) });
const progress = (startAfter?: string) => ({
  startAfter,
  metrics: createSweepMetrics(startAfter !== undefined),
  checkpoint: vi.fn().mockResolvedValue(undefined),
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('trace delivery sweep throttling', () => {
  it('retries a throttled page without enqueueing earlier pages twice and counts each attempt', async () => {
    vi.useFakeTimers();
    const list = vi
      .fn()
      .mockResolvedValueOnce({ objects: [oldObject('first')], truncated: true })
      .mockRejectedValueOnce(throttle)
      .mockRejectedValueOnce(throttle)
      .mockResolvedValueOnce({ objects: [oldObject('second')], truncated: false });
    const queue = { sendBatch: vi.fn().mockResolvedValue(undefined) };
    const state = progress();
    const sweep = sweepTraceDeliveries(
      { list } as unknown as R2Bucket,
      queue as never,
      logger,
      'prod',
      state,
      600_001,
    );

    await vi.advanceTimersByTimeAsync(999);
    expect(list).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(251);
    expect(list).toHaveBeenCalledTimes(3);
    await vi.runAllTimersAsync();

    await expect(sweep).resolves.toMatchObject({
      enqueued: 2,
      pages: 2,
      listAttempts: 4,
      throttles: 2,
      stopReason: 'complete',
    });
    expect(queue.sendBatch.mock.calls).toEqual([
      [[{ body: { type: 'delivery', key: 'first' } }]],
      [[{ body: { type: 'delivery', key: 'second' } }]],
    ]);
    for (const [options] of list.mock.calls.slice(1)) {
      expect(options).toEqual({
        prefix: 'trace-deliveries/prod-',
        limit: 1_000,
        startAfter: 'first',
      });
    }
    expect(state.metrics.latencyMs).toBeGreaterThanOrEqual(3_000);
  });

  it('reports persistent throttling and retains the last durable position', async () => {
    vi.useFakeTimers();
    const list = vi.fn().mockRejectedValue(throttle);
    const queue = { sendBatch: vi.fn() };
    const state = progress('previous');
    const result = expect(
      sweepTraceDeliveries({ list } as unknown as R2Bucket, queue as never, logger, 'prod', state),
    ).rejects.toBe(throttle);
    await vi.runAllTimersAsync();
    await result;
    expect(state.metrics).toMatchObject({
      listAttempts: 4,
      throttles: 4,
      pages: 0,
      stopReason: 'error',
    });
    expect(state.checkpoint).not.toHaveBeenCalled();
    expect(queue.sendBatch).not.toHaveBeenCalled();
  });

  it('propagates other list failures immediately', async () => {
    const error = new Error('list: Permission denied. (10014)');
    const list = vi.fn().mockRejectedValue(error);
    const state = progress();
    await expect(
      sweepTraceDeliveries({ list } as unknown as R2Bucket, {} as never, logger, 'prod', state),
    ).rejects.toBe(error);
    expect(state.metrics).toMatchObject({ listAttempts: 1, throttles: 0 });
  });
});

describe('bounded recovery progress', () => {
  it('stops after ten pages and resumes from the saved key on the next run', async () => {
    const objects = Array.from({ length: 11 }, (_, i) => oldObject(String(i).padStart(2, '0')));
    const list = vi.fn(async (options: R2ListOptions) => {
      const index = options.startAfter
        ? objects.findIndex((o) => o.key === options.startAfter) + 1
        : 0;
      return { objects: [objects[index]!], truncated: index < objects.length - 1 };
    });
    const queue = { sendBatch: vi.fn().mockResolvedValue(undefined) };
    const first = progress();
    await expect(
      sweepTraceDeliveries(
        { list } as unknown as R2Bucket,
        queue as never,
        logger,
        'prod',
        first,
        600_001,
      ),
    ).resolves.toMatchObject({ pages: 10, enqueued: 10, hasMore: true, stopReason: 'page_limit' });
    expect(first.checkpoint).toHaveBeenLastCalledWith('09');
    const second = progress('09');
    await expect(
      sweepTraceDeliveries(
        { list } as unknown as R2Bucket,
        queue as never,
        logger,
        'prod',
        second,
        600_001,
      ),
    ).resolves.toMatchObject({ pages: 1, enqueued: 1, hasMore: false, stopReason: 'complete' });
    expect(second.checkpoint).toHaveBeenCalledWith(undefined);
    expect(queue.sendBatch.mock.calls.flatMap(([batch]) => batch)).toHaveLength(11);
  });

  it('finishes the current page and checkpoints before stopping for the time budget', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(600_001);
    const list = vi.fn().mockResolvedValue({ objects: [oldObject('first')], truncated: true });
    const queue = {
      sendBatch: vi.fn(async () => {
        now.mockReturnValue(631_001);
      }),
    };
    const state = progress();
    await expect(
      sweepTraceDeliveries({ list } as unknown as R2Bucket, queue as never, logger, 'prod', state),
    ).resolves.toMatchObject({
      pages: 1,
      enqueued: 1,
      stopReason: 'time_budget',
      latencyMs: 31_000,
    });
    expect(list).toHaveBeenCalledOnce();
    expect(state.checkpoint).toHaveBeenCalledWith('first');
  });

  it('keeps a partially published page for replay when a later batch fails', async () => {
    const list = vi.fn().mockResolvedValue({
      objects: Array.from({ length: 125 }, (_, i) => oldObject(`key-${i}`)),
      truncated: true,
    });
    const error = new Error('Queue unavailable');
    const queue = {
      sendBatch: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(error),
    };
    const state = progress();
    await expect(
      sweepTraceDeliveries(
        { list } as unknown as R2Bucket,
        queue as never,
        logger,
        'prod',
        state,
        600_001,
      ),
    ).rejects.toBe(error);
    expect(state.checkpoint).not.toHaveBeenCalled();
    expect(state.metrics).toMatchObject({
      enqueued: 100,
      enqueueFailures: 1,
      queueBatchAttempts: 2,
      stopReason: 'error',
    });
  });

  it.each([
    { objects: [], truncated: true },
    { objects: [oldObject('previous')], truncated: true },
  ])('fails visibly if a truncated listing makes no progress', async (page) => {
    const state = progress('previous');
    await expect(
      sweepTraceDeliveries(
        { list: vi.fn().mockResolvedValue(page) } as unknown as R2Bucket,
        {} as never,
        logger,
        'prod',
        state,
      ),
    ).rejects.toThrow('position did not advance');
    expect(state.checkpoint).not.toHaveBeenCalled();
  });
});
