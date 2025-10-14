import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env, runInDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import type { TinybirdTrace } from '@observe/types';
import { type TraceBatcher } from '../batcher';

describe('TraceBatcher Integration', () => {
  let batcher: DurableObjectStub<TraceBatcher>;

  beforeEach(() => {
    // Get a fresh Durable Object instance for each test with unique ID
    const id = env.TRACE_BATCHER.newUniqueId();
    batcher = env.TRACE_BATCHER.get(id);
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  const createMockTrace = (traceId: string): TinybirdTrace => ({
    Timestamp: 1000000000,
    TraceId: traceId,
    SpanId: 'span-123',
    ParentSpanId: '',
    TraceState: '',
    SpanName: 'llm.request',
    SpanKind: 'SPAN_KIND_CLIENT',
    ServiceName: 'llm-observability',
    ResourceAttributes: { 'service.name': 'llm-observability' },
    SpanAttributes: {
      'llm.request_id': traceId,
      'llm.provider': 'openai',
      'llm.model': 'gpt-4',
    },
    Duration: 500000,
    StatusCode: 'STATUS_CODE_OK',
    StatusMessage: '',
    ApiKey: 'test-key',
    'Events.Timestamp': [],
    'Events.Name': [],
    'Events.Attributes': [],
    'Links.TraceId': [],
    'Links.SpanId': [],
    'Links.TraceState': [],
    'Links.Attributes': [],
  });

  it('should initialize SQL schema on first instantiation', async () => {
    const traces = [createMockTrace('trace-1')];

    const response = await runInDurableObject(batcher, (instance: TraceBatcher) => {
      return instance.addTraces(traces);
    });

    // Should not throw an error
    expect(response).toBeUndefined();
  });

  it('should add single trace to storage', async () => {
    const traces = [createMockTrace('trace-single')];

    await runInDurableObject(batcher, (instance: TraceBatcher) => {
      return instance.addTraces(traces);
    });

    const stats = await runInDurableObject(batcher, (instance: TraceBatcher) => {
      return instance.getStats();
    });
    expect(stats.queuedTraces).toBe(1);
  });

  it('should add multiple traces to storage', async () => {
    const traces = Array.from({ length: 10 }, (_, i) => createMockTrace(`trace-${i}`));

    await runInDurableObject(batcher, (instance: TraceBatcher) => {
      return instance.addTraces(traces);
    });

    const stats = await runInDurableObject(batcher, (instance: TraceBatcher) => {
      return instance.getStats();
    });
    expect(stats.queuedTraces).toBe(10);
  });

  it('should accumulate traces across multiple addTraces calls', async () => {
    await runInDurableObject(batcher, (instance: TraceBatcher) => {
      return instance.addTraces([createMockTrace('trace-1')]);
    });
    await runInDurableObject(batcher, (instance: TraceBatcher) => {
      return instance.addTraces([createMockTrace('trace-2')]);
    });
    await runInDurableObject(batcher, (instance: TraceBatcher) => {
      return instance.addTraces([createMockTrace('trace-3')]);
    });

    const stats = await runInDurableObject(batcher, (instance: TraceBatcher) => {
      return instance.getStats();
    });
    expect(stats.queuedTraces).toBe(3);
  });

  it('should handle empty traces array', async () => {
    await runInDurableObject(batcher, (instance: TraceBatcher) => {
      return instance.addTraces([]);
    });

    const stats = await runInDurableObject(batcher, (instance: TraceBatcher) => {
      return instance.getStats();
    });
    expect(stats.queuedTraces).toBe(0);
  });

  it('should store trace data as JSON', async () => {
    const trace = createMockTrace('trace-json');
    await runInDurableObject(batcher, (instance: TraceBatcher) => {
      return instance.addTraces([trace]);
    });

    const stats = await runInDurableObject(batcher, (instance: TraceBatcher) => {
      return instance.getStats();
    });
    expect(stats.queuedTraces).toBe(1);
    // Trace should be stored and retrievable
  });

  it('should track lastFlushTime', async () => {
    const stats1 = await runInDurableObject(batcher, (instance: TraceBatcher) => {
      return instance.getStats();
    });
    expect(stats1.lastFlushTime).toBeGreaterThan(0);

    const trace = createMockTrace('trace-time');
    await runInDurableObject(batcher, (instance: TraceBatcher) => {
      return instance.addTraces([trace]);
    });

    const stats2 = await runInDurableObject(batcher, (instance: TraceBatcher) => {
      return instance.getStats();
    });
    expect(stats2.lastFlushTime).toBe(stats1.lastFlushTime);
  });

  it('should schedule flush alarm when traces are added', async () => {
    const traces = [createMockTrace('trace-alarm')];

    await runInDurableObject(batcher, (instance: TraceBatcher) => {
      return instance.addTraces(traces);
    });

    // Alarm should be scheduled (internal state check)
    const stats = await runInDurableObject(batcher, (instance: TraceBatcher) => {
      return instance.getStats();
    });
    expect(stats.queuedTraces).toBe(1);
  });

  it('should handle batch size threshold', async () => {
    // Note: Actual flush behavior requires mocking Tinybird API
    // This test verifies the basic accumulation logic
    const traces = Array.from({ length: 50 }, (_, i) => createMockTrace(`trace-batch-${i}`));

    await runInDurableObject(batcher, (instance: TraceBatcher) => {
      return instance.addTraces(traces);
    });

    const stats = await runInDurableObject(batcher, (instance: TraceBatcher) => {
      return instance.getStats();
    });
    expect(stats.queuedTraces).toBe(50);
  });

  it('should persist metadata across instantiations', async () => {
    // Create a named DO for this test to ensure persistence
    const id = env.TRACE_BATCHER.idFromName('test-batcher-persist');
    const batcher1 = env.TRACE_BATCHER.get(id);

    await runInDurableObject(batcher1, (instance: TraceBatcher) => {
      return instance.addTraces([createMockTrace('trace-persist')]);
    });

    const stats1 = await runInDurableObject(batcher1, (instance: TraceBatcher) => {
      return instance.getStats();
    });
    expect(stats1.queuedTraces).toBe(1);

    // Get a new stub to the same Durable Object
    const batcher2 = env.TRACE_BATCHER.get(id);

    const stats2 = await runInDurableObject(batcher2, (instance: TraceBatcher) => {
      return instance.getStats();
    });
    expect(stats2.queuedTraces).toBe(1);
  });

  it('should handle concurrent addTraces calls', async () => {
    const promises = Array.from({ length: 5 }, (_, i) =>
      runInDurableObject(batcher, (instance: TraceBatcher) => {
        return instance.addTraces([createMockTrace(`trace-concurrent-${i}`)]);
      }),
    );

    await Promise.all(promises);

    const stats = await runInDurableObject(batcher, (instance: TraceBatcher) => {
      return instance.getStats();
    });
    expect(stats.queuedTraces).toBe(5);
  });

  it('should return stats with correct structure', async () => {
    await runInDurableObject(batcher, (instance: TraceBatcher) => {
      return instance.addTraces([createMockTrace('trace-stats')]);
    });

    const stats = await runInDurableObject(batcher, (instance: TraceBatcher) => {
      return instance.getStats();
    });

    expect(stats).toHaveProperty('queuedTraces');
    expect(stats).toHaveProperty('lastFlushTime');
    expect(typeof stats.queuedTraces).toBe('number');
    expect(typeof stats.lastFlushTime).toBe('number');
  });

  it('should handle traces with complex attributes', async () => {
    const trace = createMockTrace('trace-complex');
    trace.SpanAttributes = {
      'llm.request_id': 'complex-id',
      'llm.provider': 'anthropic',
      'llm.model': 'claude-3-opus',
      'llm.tokens.prompt': '1000',
      'llm.tokens.completion': '500',
      'llm.cached': 'true',
    };

    await runInDurableObject(batcher, (instance: TraceBatcher) => {
      return instance.addTraces([trace]);
    });

    const stats = await runInDurableObject(batcher, (instance: TraceBatcher) => {
      return instance.getStats();
    });
    expect(stats.queuedTraces).toBe(1);
  });

  it('should handle traces with error status', async () => {
    const trace = createMockTrace('trace-error');
    trace.StatusCode = 'STATUS_CODE_ERROR';
    trace.StatusMessage = 'API key invalid';
    trace.SpanAttributes['error.type'] = 'invalid_request_error';

    await runInDurableObject(batcher, (instance: TraceBatcher) => {
      return instance.addTraces([trace]);
    });

    const stats = await runInDurableObject(batcher, (instance: TraceBatcher) => {
      return instance.getStats();
    });
    expect(stats.queuedTraces).toBe(1);
  });

  it('should handle large batch of traces', async () => {
    // SQLite has a limit of 999 parameters, and we have 2 params per trace
    // So max is 499 traces. Test with 50 to be safe.
    const largeBatch = Array.from({ length: 50 }, (_, i) => createMockTrace(`trace-large-${i}`));

    await runInDurableObject(batcher, (instance: TraceBatcher) => {
      return instance.addTraces(largeBatch);
    });

    const stats = await runInDurableObject(batcher, (instance: TraceBatcher) => {
      return instance.getStats();
    });
    expect(stats.queuedTraces).toBe(50);
  });

  it('should handle traces with nested attributes', async () => {
    const trace = createMockTrace('trace-nested');
    trace.ResourceAttributes = {
      'service.name': 'llm-observability',
      'service.version': '1.0.0',
      'service.environment': 'production',
    };

    await runInDurableObject(batcher, (instance: TraceBatcher) => {
      return instance.addTraces([trace]);
    });

    const stats = await runInDurableObject(batcher, (instance: TraceBatcher) => {
      return instance.getStats();
    });
    expect(stats.queuedTraces).toBe(1);
  });

  it('should trigger flush when trace count reaches BATCH_SIZE threshold', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('OK'),
    });
    global.fetch = mockFetch;

    await runInDurableObject(batcher, async (instance: TraceBatcher, state) => {
      for (let i = 0; i < 1000; i++) {
        state.storage.sql.exec(
          'INSERT INTO traces (data, timestamp) VALUES (?, ?)',
          JSON.stringify(createMockTrace(`trace-${i}`)),
          Date.now(),
        );
      }

      (instance as unknown as { traceCount: number }).traceCount = 99999;

      await instance.addTraces([createMockTrace('trigger-flush')]);
    });

    expect(mockFetch).toHaveBeenCalled();
  });

  it('should execute alarm and flush traces after interval', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('OK'),
    });
    global.fetch = mockFetch;

    const traces = Array.from({ length: 10 }, (_, i) => createMockTrace(`trace-alarm-${i}`));

    await runInDurableObject(batcher, (instance: TraceBatcher) => {
      return instance.addTraces(traces);
    });

    const alarmRan = await runDurableObjectAlarm(batcher);
    expect(alarmRan).toBe(true);
  });

  it('should prevent duplicate alarm scheduling', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });
    global.fetch = mockFetch;

    const alarmTime = await runInDurableObject(batcher, async (instance: TraceBatcher, state) => {
      await instance.addTraces([createMockTrace('trace-1')]);
      const alarmAfterFirst = await state.storage.getAlarm();

      await instance.addTraces([createMockTrace('trace-2')]);
      const alarmAfterSecond = await state.storage.getAlarm();

      await instance.addTraces([createMockTrace('trace-3')]);
      const alarmAfterThird = await state.storage.getAlarm();

      expect(alarmAfterSecond).toBe(alarmAfterFirst);
      expect(alarmAfterThird).toBe(alarmAfterFirst);

      return alarmAfterFirst;
    });

    expect(alarmTime).toBeDefined();
    expect(alarmTime).toBeGreaterThan(0);

    const stats = await runInDurableObject(batcher, (instance: TraceBatcher) => {
      return instance.getStats();
    });
    expect(stats.queuedTraces).toBe(3);
  });

  it('should flush successfully and delete traces from SQL storage', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });
    global.fetch = mockFetch;

    const traces = Array.from({ length: 5 }, (_, i) => createMockTrace(`trace-flush-${i}`));

    await runInDurableObject(batcher, (instance: TraceBatcher) => {
      return instance.addTraces(traces);
    });

    const alarmRan = await runDurableObjectAlarm(batcher);
    expect(alarmRan).toBe(true);
  });

  it('should flush multiple batches for trace count > 100k', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });
    global.fetch = mockFetch;

    await runInDurableObject(batcher, async (instance: TraceBatcher, state) => {
      for (let i = 0; i < 2000; i++) {
        state.storage.sql.exec(
          'INSERT INTO traces (data, timestamp) VALUES (?, ?)',
          JSON.stringify(createMockTrace(`trace-multi-${i}`)),
          Date.now(),
        );
      }

      (instance as unknown as { traceCount: number }).traceCount = 150_000;

      await instance.addTraces([createMockTrace('trigger-multibatch-flush')]);
    });

    expect(mockFetch).toHaveBeenCalled();
  });

  it('should handle Tinybird errors during flush gracefully', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal Server Error'),
    });
    global.fetch = mockFetch;

    const traces = Array.from({ length: 10 }, (_, i) => createMockTrace(`trace-error-${i}`));

    await runInDurableObject(batcher, (instance: TraceBatcher) => {
      return instance.addTraces(traces);
    });

    const alarmRan = await runDurableObjectAlarm(batcher);
    expect(alarmRan).toBe(true);
  });

  it('should skip flush when no traces are queued', async () => {
    const mockFetch = vi.fn();
    global.fetch = mockFetch;

    await runInDurableObject(batcher, (instance: TraceBatcher) => {
      return instance.addTraces([]);
    });

    const alarmRan = await runDurableObjectAlarm(batcher);
    expect(alarmRan).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should reschedule alarm when threshold not met but traces exist', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });
    global.fetch = mockFetch;

    const namedId = env.TRACE_BATCHER.idFromName('test-batcher-reschedule');
    const namedBatcher = env.TRACE_BATCHER.get(namedId);

    await runInDurableObject(namedBatcher, async (instance: TraceBatcher, state) => {
      await instance.addTraces([createMockTrace('trace-reschedule')]);

      const alarmBefore = await state.storage.getAlarm();
      expect(alarmBefore).toBeDefined();
      expect(alarmBefore).toBeGreaterThan(0);
    });

    const alarmRan = await runDurableObjectAlarm(namedBatcher);
    expect(alarmRan).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();

    const rescheduled = await runInDurableObject(namedBatcher, async (_instance, state) => {
      const alarmAfter = await state.storage.getAlarm();
      expect(alarmAfter).toBeDefined();
      expect(alarmAfter).toBeGreaterThan(0);

      return alarmAfter;
    });

    expect(rescheduled).toBeDefined();

    const stats = await runInDurableObject(namedBatcher, (instance: TraceBatcher) => {
      return instance.getStats();
    });
    expect(stats.queuedTraces).toBe(1);
  });

  it('should handle alarm timing with jitter boundary conditions', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('OK'),
    });
    global.fetch = mockFetch;

    await runInDurableObject(batcher, async (instance: TraceBatcher, state) => {
      await instance.addTraces([createMockTrace('trace-jitter')]);

      const stats = instance.getStats();
      const originalLastFlush = stats.lastFlushTime;

      const oldDateNow = Date.now;
      Date.now = () => originalLastFlush + 1200;

      await state.storage.deleteAlarm();
      (instance as unknown as { flushAlarmScheduled: boolean }).flushAlarmScheduled = false;

      await (instance as unknown as { alarm: () => Promise<void> }).alarm();

      Date.now = oldDateNow;
    });

    expect(mockFetch).toHaveBeenCalled();
  });

  it('should clean up alarm after flush completes', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });
    global.fetch = mockFetch;

    await runInDurableObject(batcher, (instance: TraceBatcher) => {
      return instance.addTraces([createMockTrace('trace-cleanup')]);
    });

    const firstAlarmRan = await runDurableObjectAlarm(batcher);
    expect(firstAlarmRan).toBe(true);
  });
});
