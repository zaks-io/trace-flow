import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { TraceBatcherInstance } from '../batcher';
import { createMockTrace } from './fixtures';

describe('TraceBatcher Integration', () => {
  let batcher: DurableObjectStub<TraceBatcherInstance>;

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

  it('should expose enriched stats for queued traces', async () => {
    const now = Date.now();

    const firstResults = await runInDurableObject(batcher, (instance: TraceBatcherInstance) => {
      return instance.addMessageTraces([
        { messageId: 'msg-1', traces: [createMockTrace('trace-msg-1')] },
      ]);
    });
    expect(firstResults).toEqual([{ messageId: 'msg-1', status: 'inserted' }]);

    const secondResults = await runInDurableObject(batcher, (instance: TraceBatcherInstance) => {
      return instance.addMessageTraces([
        { messageId: 'msg-1', traces: [createMockTrace('trace-msg-1-dup')] },
      ]);
    });
    expect(secondResults).toEqual([{ messageId: 'msg-1', status: 'duplicate' }]);

    const stats = await runInDurableObject(batcher, (instance: TraceBatcherInstance) => {
      return instance.getStats();
    });

    expect(stats).toEqual({
      queuedTraces: 1,
      oldestQueuedTraceTime: now,
      lastSuccessfulFlushTime: now,
      lastFlushTime: now,
    });
  });

  it('should keep the oldest queued trace timestamp across later inserts', async () => {
    const firstInsertTime = Date.now();
    await runInDurableObject(batcher, (instance: TraceBatcherInstance) => {
      return instance.addMessageTraces([
        { messageId: 'msg-2', traces: [createMockTrace('trace-msg-2')] },
      ]);
    });

    vi.advanceTimersByTime(60_000);

    const results = await runInDurableObject(batcher, (instance: TraceBatcherInstance) => {
      return instance.addMessageTraces([
        { messageId: 'msg-2', traces: [createMockTrace('trace-msg-2-dup')] },
        { messageId: 'msg-3', traces: [createMockTrace('trace-msg-3')] },
      ]);
    });

    expect(results).toEqual([
      { messageId: 'msg-2', status: 'duplicate' },
      { messageId: 'msg-3', status: 'inserted' },
    ]);

    const stats = await runInDurableObject(batcher, (instance: TraceBatcherInstance) => {
      return instance.getStats();
    });

    expect(stats.queuedTraces).toBe(2);
    expect(stats.oldestQueuedTraceTime).toBe(firstInsertTime);
    expect(stats.lastSuccessfulFlushTime).toBe(firstInsertTime);
    expect(stats.lastFlushTime).toBeGreaterThanOrEqual(firstInsertTime);
  });

  it('should report no oldest queued trace when the queue is empty', async () => {
    const stats = await runInDurableObject(batcher, (instance: TraceBatcherInstance) => {
      return instance.getStats();
    });

    expect(stats.queuedTraces).toBe(0);
    expect(stats.oldestQueuedTraceTime).toBeNull();
  });
});
