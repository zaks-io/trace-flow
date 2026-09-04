import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type * as SentryCloudflare from '@sentry/cloudflare';
import { env as workerEnv } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import type { TraceBatcherInstance, MessageTraceBatchItem, MessageTraceResult } from '../batcher';
import {
  TRACE_BATCHER_FLUSH_INTERVAL_MS,
  TRACE_BATCHER_MAX_INSERT_ROWS,
  TRACE_BATCHER_MAX_JITTER_MS,
} from '../batcher';
import { createMockTrace } from './fixtures';
import { TinybirdInsertError, TinybirdRecoveryStore } from '@trace-flow/tinybird-client';
import { analyticsKeyId } from '@trace-flow/utils';
import { insertIntoTinybirdWithRetry } from '../tinybird';

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

// Run the batcher unwrapped. Sentry's RPC instrumentation ends every call with a
// `waitUntil(client.flush())`, and the flush drains on a real timer that the fake timers below
// never advance, so the DO invocation would never settle. Trace propagation is the SDK's
// behavior, not this DO's logic.
vi.mock('@sentry/cloudflare', async (importOriginal) => ({
  ...(await importOriginal<typeof SentryCloudflare>()),
  instrumentDurableObjectWithSentry: <T>(_options: unknown, DurableObjectClass: T): T =>
    DurableObjectClass,
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

  const forceFlush = () =>
    runInDurableObject(batcher, async (instance: TraceBatcherInstance, state) => {
      const result = await instance.forceFlush();
      await state.storage.deleteAlarm();
      return result;
    });

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

  it('retains message tombstones beyond seven days', async () => {
    await addTraces([{ messageId: 'durable-message', traces: [createMockTrace('original')] }]);

    vi.advanceTimersByTime(8 * 24 * 60 * 60 * 1000);

    const replay = await addTraces([
      { messageId: 'durable-message', traces: [createMockTrace('replayed-with-new-span-ids')] },
    ]);

    expect(replay).toEqual([{ messageId: 'durable-message', status: 'duplicate' }]);
    expect((await getStats()).queuedTraces).toBe(1);
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
    const recovery = await runInDurableObject(batcher, (instance: TraceBatcherInstance) =>
      instance.listRecovery(),
    );
    expect(JSON.parse(recovery.records[0]?.payload ?? '{}')).toMatchObject({
      StatusMessage: 'changed after first ingestion',
    });
  });

  it('dedupes repeated span repair candidates across message IDs', async () => {
    await addTraces([{ messageId: 'repair-original', traces: [createMockTrace('repair-repeat')] }]);
    const changed = {
      ...createMockTrace('repair-repeat'),
      StatusMessage: 'same changed payload',
    };

    await addTraces([{ messageId: 'repair-change-1', traces: [changed] }]);
    await addTraces([{ messageId: 'repair-change-2', traces: [changed] }]);

    const result = await runInDurableObject(batcher, (instance: TraceBatcherInstance, state) => ({
      repairs: state.storage.sql
        .exec<{ count: number }>('SELECT COUNT(*) AS count FROM trace_repairs')
        .one().count,
      recovery: instance.listRecovery(),
    }));
    expect(result.repairs).toBe(1);
    expect(result.recovery.records).toHaveLength(1);
  });

  it('quarantines an interrupted in-flight insert without reposting it', async () => {
    await addTraces([{ messageId: 'msg-interrupted', traces: [createMockTrace('interrupted')] }]);
    await runInDurableObject(batcher, (_instance: TraceBatcherInstance, state) => {
      const row = state.storage.sql
        .exec<{ id: number; data: string }>('SELECT id, data FROM traces')
        .one();
      const recovery = new TinybirdRecoveryStore(state.storage);
      recovery.beginInsert('otel_trace_spans', 'clean_sent_at_ms', `[${row.data}]`, [row.id]);
      recovery.initialize();
    });

    await forceFlush();

    expect(insertIntoTinybirdWithRetry).not.toHaveBeenCalled();
    const page = await runInDurableObject(batcher, (instance: TraceBatcherInstance) =>
      instance.listRecovery(),
    );
    expect(page.records[0]).toMatchObject({ classification: 'uncertain', state: 'blocked' });
  });

  it('retries a definite 429 on the next alarm without blocking the row', async () => {
    await addTraces([{ messageId: 'msg-rate-limit', traces: [createMockTrace('rate-limit')] }]);
    vi.mocked(insertIntoTinybirdWithRetry)
      .mockRejectedValueOnce(new TinybirdInsertError(429, 'rate limited'))
      .mockResolvedValueOnce(undefined);

    await forceFlush();
    expect((await getStats()).blockedRecoveryRecords).toBe(0);
    expect((await getStats()).queuedTraces).toBe(1);
    await forceFlush();
    expect((await getStats()).queuedTraces).toBe(0);
  });

  it('backs off when a 413 split contains a retryable child without resending its successful sibling', async () => {
    await addTraces([
      {
        messageId: 'msg-split-retry',
        traces: [createMockTrace('split-success'), createMockTrace('split-retry')],
      },
    ]);
    vi.mocked(insertIntoTinybirdWithRetry)
      .mockRejectedValueOnce(new TinybirdInsertError(413, 'batch too large'))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new TinybirdInsertError(429, 'rate limited'));

    await forceFlush();

    expect(insertIntoTinybirdWithRetry).toHaveBeenCalledTimes(3);
    expect((await getStats()).queuedTraces).toBe(1);
    expect((await getStats()).blockedRecoveryRecords).toBe(0);

    vi.mocked(insertIntoTinybirdWithRetry).mockResolvedValueOnce(undefined);
    await forceFlush();

    expect(insertIntoTinybirdWithRetry).toHaveBeenCalledTimes(4);
    expect(vi.mocked(insertIntoTinybirdWithRetry).mock.calls[3]?.[0]).toEqual([
      expect.objectContaining({ TraceId: 'split-retry' }),
    ]);
    expect((await getStats()).queuedTraces).toBe(0);
  });

  it('stores the normalized analytics identity used for an uncertain insert', async () => {
    const trace = createMockTrace('normalized-recovery');
    const expectedApiKey = await analyticsKeyId(trace.ApiKey);
    await addTraces([{ messageId: 'msg-normalized-recovery', traces: [trace] }]);
    vi.mocked(insertIntoTinybirdWithRetry).mockRejectedValueOnce(
      new Error('connection closed after request'),
    );

    await forceFlush();

    const page = await runInDurableObject(batcher, (instance: TraceBatcherInstance) =>
      instance.listRecovery(),
    );
    expect(page.records[0]).toMatchObject({ classification: 'uncertain', state: 'blocked' });
    const recovered = JSON.parse(page.records[0]?.payload ?? '[]');
    expect(recovered).toEqual(vi.mocked(insertIntoTinybirdWithRetry).mock.calls[0]?.[0]);
    expect(recovered[0]?.ApiKey).toBe(expectedApiKey);
    expect(page.records[0]?.payload).not.toContain(trace.ApiKey);
  });

  it('preserves malformed pending traces as rejected recovery records', async () => {
    await addTraces([{ messageId: 'msg-malformed-row', traces: [createMockTrace('malformed')] }]);
    await runInDurableObject(batcher, (_instance: TraceBatcherInstance, state) => {
      state.storage.sql.exec(`UPDATE traces SET data = '{malformed'`);
    });
    vi.mocked(insertIntoTinybirdWithRetry).mockClear();

    await forceFlush();

    expect(insertIntoTinybirdWithRetry).not.toHaveBeenCalled();
    const page = await runInDurableObject(batcher, (instance: TraceBatcherInstance) =>
      instance.listRecovery(),
    );
    expect(page.records[0]).toMatchObject({ classification: 'rejected', state: 'blocked' });
    expect(page.records[0]?.payload).toBe('[{malformed]');
  });

  it('isolates a rejected row so later healthy work still flushes', async () => {
    await addTraces([{ messageId: 'msg-rejected', traces: [createMockTrace('rejected')] }]);
    vi.mocked(insertIntoTinybirdWithRetry).mockRejectedValueOnce(
      new TinybirdInsertError(400, 'bad row'),
    );
    await forceFlush();

    await addTraces([{ messageId: 'msg-healthy', traces: [createMockTrace('healthy')] }]);
    vi.mocked(insertIntoTinybirdWithRetry).mockResolvedValueOnce(undefined);
    await forceFlush();

    const stats = await getStats();
    expect(stats.queuedTraces).toBe(0);
    expect(stats.blockedRecoveryRows).toBe(1);
    const recovery = await runInDurableObject(batcher, (instance: TraceBatcherInstance) =>
      instance.listRecovery(),
    );
    expect(recovery.records[0]).toMatchObject({ classification: 'rejected' });
    expect(recovery.records[0]?.target).toMatch(/^otel_trace/);

    await expect(
      runInDurableObject(batcher, async (instance: TraceBatcherInstance, state) => {
        const setAlarm = vi
          .spyOn(state.storage, 'setAlarm')
          .mockRejectedValueOnce(new Error('alarm storage unavailable'));
        try {
          await instance.reconcileRecovery({
            recoveryId: recovery.records[0]!.id,
            action: 'confirm-not-written',
            reason: 'operator verified the row was not written',
          });
        } finally {
          setAlarm.mockRestore();
        }
      }),
    ).rejects.toThrow('alarm storage unavailable');
    expect(
      await runInDurableObject(batcher, (instance: TraceBatcherInstance) =>
        instance.getRecovery(recovery.records[0]!.id),
      ),
    ).toMatchObject({ state: 'blocked', resolution: null });

    await expect(
      runInDurableObject(batcher, (instance: TraceBatcherInstance) =>
        instance.reconcileRecovery({
          recoveryId: recovery.records[0]!.id,
          action: 'invalid' as 'confirm-written',
          reason: 'must not mutate',
        }),
      ),
    ).rejects.toThrow('invalid recovery action');
    vi.mocked(insertIntoTinybirdWithRetry).mockClear();
    const resolved = await runInDurableObject(batcher, (instance: TraceBatcherInstance) =>
      instance.reconcileRecovery({
        recoveryId: recovery.records[0]!.id,
        action: 'confirm-written',
        reason: 'operator verified the row exists',
      }),
    );
    await forceFlush();
    expect(resolved).toMatchObject({ state: 'resolved', resolution: 'confirm-written' });
    expect(insertIntoTinybirdWithRetry).not.toHaveBeenCalled();
  });

  it('retains a multi-megabyte individual row as rejected without sending it', async () => {
    const trace = { ...createMockTrace('oversized'), StatusMessage: 'x'.repeat(2_100_000) };
    await addTraces([{ messageId: 'msg-oversized', traces: [trace] }]);
    await forceFlush();

    expect(insertIntoTinybirdWithRetry).not.toHaveBeenCalled();
    const recovery = await runInDurableObject(batcher, (instance: TraceBatcherInstance) =>
      instance.listRecovery(),
    );
    expect(JSON.parse(recovery.records[0]?.payload ?? '[]')[0].StatusMessage).toHaveLength(
      2_100_000,
    );
  });

  it('excludes blocked recovery rows from the age of healthy queued work', async () => {
    await addTraces([{ messageId: 'old-blocked', traces: [createMockTrace('old-blocked')] }]);
    vi.mocked(insertIntoTinybirdWithRetry).mockRejectedValueOnce(
      new TinybirdInsertError(400, 'rejected'),
    );
    await forceFlush();
    expect(await getStats()).toMatchObject({
      queuedTraces: 0,
      blockedRecoveryRows: 1,
      oldestQueuedTraceTime: null,
    });

    vi.setSystemTime(new Date('2024-01-02T00:00:00.000Z'));
    const freshTime = Date.now();
    await addTraces([{ messageId: 'fresh-healthy', traces: [createMockTrace('fresh-healthy')] }]);
    expect(await getStats()).toMatchObject({
      queuedTraces: 1,
      blockedRecoveryRows: 1,
      oldestQueuedTraceTime: freshTime,
    });
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
