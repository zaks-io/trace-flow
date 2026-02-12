import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { TinybirdTrace } from '@trace-flow/types';
import type { TraceBatcherInstance } from '../batcher';

describe('TraceBatcher Integration', () => {
  let batcher: DurableObjectStub<TraceBatcherInstance>;

  beforeEach(() => {
    const id = env.TRACE_BATCHER.newUniqueId();
    batcher = env.TRACE_BATCHER.get(id);
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  const createMockTrace = (traceId: string): TinybirdTrace => ({
    ReceivedAt: 1700000000000000000,
    Timestamp: 1000000000,
    TraceId: traceId,
    SpanId: 'span-123',
    ParentSpanId: '',
    TraceState: '',
    SpanName: 'gen_ai.request',
    SpanKind: 'SPAN_KIND_CLIENT',
    ServiceName: 'llm-observability',
    ResourceAttributes: { 'service.name': 'llm-observability' },
    SpanAttributes: {
      'gen_ai.request_id': traceId,
      'gen_ai.system': 'openai',
      'gen_ai.request.model': 'gpt-4',
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
    TierAtIngestion: 'hobby',
    RetentionExpiresAt: 1700604800000000000,
  });

  it('should deduplicate message IDs in addMessageTraces', async () => {
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
    expect(stats.queuedTraces).toBe(1);
  });

  it('should handle mixed batches in addMessageTraces', async () => {
    await runInDurableObject(batcher, (instance: TraceBatcherInstance) => {
      return instance.addMessageTraces([
        { messageId: 'msg-2', traces: [createMockTrace('trace-msg-2')] },
      ]);
    });

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
  });
});
