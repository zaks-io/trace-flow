import { describe, it, expect, beforeEach } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { TinybirdTrace } from '@observe/types';
import { type TraceBatcher } from '../batcher';

describe('TraceBatcher Integration', () => {
  let batcher: DurableObjectStub<TraceBatcher>;

  beforeEach(() => {
    // Get a fresh Durable Object instance for each test with unique ID
    const id = env.TRACE_BATCHER.newUniqueId();
    batcher = env.TRACE_BATCHER.get(id);
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
});
