import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env as workerEnv } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import type { TraceBatcherInstance, MessageTraceBatchItem, MessageTraceResult } from '../batcher';
import {
  TRACE_BATCHER_FLUSH_INTERVAL_MS,
  TRACE_BATCHER_MAX_INSERT_ROWS,
  TRACE_BATCHER_MAX_JITTER_MS,
} from '../batcher';
import { createMockTrace } from './fixtures';

const env = workerEnv as unknown as {
  TRACE_BATCHER: DurableObjectNamespace<TraceBatcherInstance>;
};

// Stub the Tinybird transport so nothing leaves the isolate. The DO loads this
// same module, so the mock covers any flush triggered inside the batcher. Tests
// must never touch the network.
vi.mock('../tinybird', () => ({
  insertIntoTinybird: vi.fn().mockResolvedValue(undefined),
  insertIntoTinybirdWithRetry: vi.fn().mockResolvedValue(undefined),
}));

/**
 * Covers the batcher's own logic — dedup by messageId, SQL-param chunking past
 * the per-statement row limit, and oldest-queued-trace tracking — by driving
 * the DO directly.
 *
 * `addMessageTraces` arms a real DO flush alarm. If that alarm fires it runs a
 * flush whose Sentry span belongs to the original request's I/O context, which
 * workerd rejects ("Cannot perform I/O on behalf of a different Durable
 * Object") leaving a promise that never settles and hangs the run — and it also
 * drains the queue out from under the assertions. So `addTraces` cancels the
 * alarm in the same DO invocation, before any await boundary lets it fire. The
 * flush path itself is exercised by the unit tests in tinybird.test.ts.
 */
describe('TraceBatcher logic', () => {
  let batcher: DurableObjectStub<TraceBatcherInstance>;

  const addTraces = (items: MessageTraceBatchItem[]): Promise<MessageTraceResult[]> =>
    runInDurableObject(batcher, async (instance: TraceBatcherInstance, state) => {
      const results = await instance.addMessageTraces(items);
      await state.storage.deleteAlarm();
      return results;
    });

  const getStats = () =>
    runInDurableObject(batcher, (instance: TraceBatcherInstance) => instance.getStats());

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));

    const id = env.TRACE_BATCHER.newUniqueId();
    batcher = env.TRACE_BATCHER.get(id);
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('dedupes repeated messageIds within and across inserts', async () => {
    const first = await addTraces([{ messageId: 'msg-1', traces: [createMockTrace('t-1')] }]);
    expect(first).toEqual([{ messageId: 'msg-1', status: 'inserted' }]);

    const second = await addTraces([
      { messageId: 'msg-1', traces: [createMockTrace('t-1-dup')] },
      { messageId: 'msg-2', traces: [createMockTrace('t-2')] },
    ]);
    expect(second).toEqual([
      { messageId: 'msg-1', status: 'duplicate' },
      { messageId: 'msg-2', status: 'inserted' },
    ]);
  });

  it('dedupes repeated span identity across different messageIds', async () => {
    const trace = createMockTrace('trace-same');

    await addTraces([{ messageId: 'msg-1', traces: [trace] }]);
    const second = await addTraces([{ messageId: 'msg-2', traces: [trace] }]);

    expect(second).toEqual([{ messageId: 'msg-2', status: 'inserted' }]);

    const stats = await getStats();
    expect(stats.queuedTraces).toBe(1);
  });

  it('routes changed span content to repair without queueing another trace', async () => {
    await addTraces([{ messageId: 'msg-1', traces: [createMockTrace('trace-repair')] }]);

    const changedTrace = {
      ...createMockTrace('trace-repair'),
      StatusMessage: 'changed after first ingestion',
    };
    await addTraces([{ messageId: 'msg-2', traces: [changedTrace] }]);

    const { repairCount, queuedTraces } = await runInDurableObject(
      batcher,
      (instance: TraceBatcherInstance, state) => {
        const repairRows = [
          ...state.storage.sql.exec<{ count: number }>(
            'SELECT COUNT(*) AS count FROM trace_repairs',
          ),
        ];
        return {
          repairCount: repairRows[0]?.count ?? 0,
          queuedTraces: instance.getStats().queuedTraces,
        };
      },
    );

    expect(repairCount).toBe(1);
    expect(queuedTraces).toBe(1);
  });

  it('keeps the oldest queued trace timestamp across later inserts', async () => {
    const firstInsertTime = Date.now();
    await addTraces([{ messageId: 'msg-a', traces: [createMockTrace('t-a')] }]);

    vi.advanceTimersByTime(60_000);

    await addTraces([{ messageId: 'msg-b', traces: [createMockTrace('t-b')] }]);

    const stats = await getStats();
    expect(stats.queuedTraces).toBe(2);
    expect(stats.oldestQueuedTraceTime).toBe(firstInsertTime);
  });

  it('waits for the low-volume flush interval before flushing sparse traffic', async () => {
    vi.useRealTimers();

    const scheduled = await runInDurableObject(
      batcher,
      async (instance: TraceBatcherInstance, state) => {
        const before = Date.now();
        await instance.addMessageTraces([
          { messageId: 'msg-sparse', traces: [createMockTrace('t-sparse')] },
        ]);
        const scheduledAlarm = await state.storage.getAlarm();
        const after = Date.now();
        await state.storage.deleteAlarm();
        return { after, before, alarm: scheduledAlarm };
      },
    );

    expect(scheduled.alarm).toBeGreaterThanOrEqual(
      scheduled.before + TRACE_BATCHER_FLUSH_INTERVAL_MS,
    );
    expect(scheduled.alarm).toBeLessThanOrEqual(
      scheduled.after + TRACE_BATCHER_FLUSH_INTERVAL_MS + TRACE_BATCHER_MAX_JITTER_MS,
    );
  });

  // insertMessageTraces chunks by TRACE_BATCHER_MAX_INSERT_ROWS
  // (MAX_SQL_PARAMS / 2), so cover the per-statement row limit boundary.
  it.each([
    ['just over the limit', TRACE_BATCHER_MAX_INSERT_ROWS + 1],
    ['exactly on the limit', TRACE_BATCHER_MAX_INSERT_ROWS],
    ['multiple chunks plus remainder', TRACE_BATCHER_MAX_INSERT_ROWS * 2 + 1],
  ])('inserts a batch %s without losing rows', async (_label, traceCount) => {
    const traces = Array.from({ length: traceCount }, (_, i) => createMockTrace(`chunk-${i}`));

    const results = await addTraces([{ messageId: 'msg-chunk', traces }]);
    expect(results).toEqual([{ messageId: 'msg-chunk', status: 'inserted' }]);

    const stats = await getStats();
    expect(stats.queuedTraces).toBe(traceCount);
  });
});
