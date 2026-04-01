import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { TraceBatcherInstance } from '../batcher';
import { TRACE_BATCHER_MAX_SQL_PARAMS, TRACE_BATCHER_MAX_INSERT_ROWS } from '../batcher';
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

  describe('SQL param chunking', () => {
    it('should insert traces exceeding MAX_INSERT_ROWS in a single message', async () => {
      const traceCount = TRACE_BATCHER_MAX_INSERT_ROWS + 1;
      const traces = Array.from({ length: traceCount }, (_, i) =>
        createMockTrace(`chunk-insert-${i}`),
      );

      const results = await runInDurableObject(batcher, (instance: TraceBatcherInstance) => {
        return instance.addMessageTraces([{ messageId: 'msg-large-insert', traces }]);
      });

      expect(results).toEqual([{ messageId: 'msg-large-insert', status: 'inserted' }]);

      const stats = await runInDurableObject(batcher, (instance: TraceBatcherInstance) => {
        return instance.getStats();
      });
      expect(stats.queuedTraces).toBe(traceCount);
    });

    it('should insert traces at exact MAX_INSERT_ROWS boundary', async () => {
      const traces = Array.from({ length: TRACE_BATCHER_MAX_INSERT_ROWS }, (_, i) =>
        createMockTrace(`chunk-boundary-${i}`),
      );

      const results = await runInDurableObject(batcher, (instance: TraceBatcherInstance) => {
        return instance.addMessageTraces([{ messageId: 'msg-boundary', traces }]);
      });

      expect(results).toEqual([{ messageId: 'msg-boundary', status: 'inserted' }]);

      const stats = await runInDurableObject(batcher, (instance: TraceBatcherInstance) => {
        return instance.getStats();
      });
      expect(stats.queuedTraces).toBe(TRACE_BATCHER_MAX_INSERT_ROWS);
    });

    it('should insert a large multi-chunk batch (2x + 1 boundary)', async () => {
      const traceCount = TRACE_BATCHER_MAX_INSERT_ROWS * 2 + 1;
      const traces = Array.from({ length: traceCount }, (_, i) => createMockTrace(`chunk-2x-${i}`));

      const results = await runInDurableObject(batcher, (instance: TraceBatcherInstance) => {
        return instance.addMessageTraces([{ messageId: 'msg-2x', traces }]);
      });

      expect(results).toEqual([{ messageId: 'msg-2x', status: 'inserted' }]);

      const stats = await runInDurableObject(batcher, (instance: TraceBatcherInstance) => {
        return instance.getStats();
      });
      expect(stats.queuedTraces).toBe(traceCount);
    });

    it('should export consistent constants', () => {
      expect(TRACE_BATCHER_MAX_SQL_PARAMS).toBe(90);
      expect(TRACE_BATCHER_MAX_INSERT_ROWS).toBe(45);
    });
  });
});
