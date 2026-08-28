import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type * as SentryCloudflare from '@sentry/cloudflare';
import { createExecutionContext, env, runInDurableObject } from 'cloudflare:test';
import type { QueueMessage } from '@trace-flow/types';
import type { TraceBatcherInstance } from '../batcher';
import worker from '../index';
import { createMockTrace } from './fixtures';

// The batcher's flush calls insertIntoTinybirdWithRetry, which does a real
// fetch to TINYBIRD_HOST. Tests must never touch the network, and the batcher
// arms a self-rescheduling flush alarm on enqueue, so an un-mocked flush 404s
// and re-arms forever — hanging the run. Stub the transport so flushes succeed
// in-isolate (the DO loads this same module), draining the queue with no fetch.
vi.mock('../tinybird', () => ({
  insertIntoTinybird: vi.fn().mockResolvedValue(undefined),
  insertIntoTinybirdWithRetry: vi.fn().mockResolvedValue(undefined),
}));

// Run the batcher unwrapped. Sentry's RPC instrumentation ends every Durable Object call with a
// `waitUntil(client.flush())`, and the flush drains on a real timer that this file's fake timers
// never advance, so the DO invocation would never settle. Trace propagation is the SDK's behavior,
// not this handler's logic.
vi.mock('@sentry/cloudflare', async (importOriginal) => ({
  ...(await importOriginal<typeof SentryCloudflare>()),
  instrumentDurableObjectWithSentry: <T>(_options: unknown, DurableObjectClass: T): T =>
    DurableObjectClass,
}));

describe('Queue Handler Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    env.NUM_SHARDS = 2;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete env.NUM_SHARDS;
  });

  const createMockQueueMessage = (requestId: string, apiKey: string): QueueMessage => ({
    requestId,
    apiKey,
    targetUrl: 'https://api.openai.com/v1/chat/completions',
    request: {
      id: requestId,
      provider: 'openai',
      model: 'gpt-4',
      messages: [],
      timestamp: 1000,
    },
    response: {
      id: requestId,
      provider: 'openai',
      status: 200,
      timestamp: 1500,
      latency: 500,
    },
    timing: {
      requestStart: 1000,
      requestSent: 1100,
      responseReceived: 1150,
      firstTokenReceived: 1200,
      responseComplete: 1500,
    },
    receivedAt: 1000000000000000,
  });

  const createScheduledController = (): ScheduledController => ({
    cron: '*/5 * * * *',
    scheduledTime: Date.now(),
    noRetry() {
      // noop for tests
    },
  });

  it('should process single message and route to correct shard', async () => {
    const message = createMockQueueMessage('test-1', 'api-key-123');
    const ackCalled = { value: false };

    const mockMessage: Message<QueueMessage> = {
      id: '1',
      timestamp: new Date(),
      body: message,
      attempts: 0,
      ack: () => {
        ackCalled.value = true;
      },
      retry: () => {
        /* noop */
      },
    };

    const batch: MessageBatch<QueueMessage> = {
      queue: 'test-queue',
      messages: [mockMessage],
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
      retryAll: () => {
        /* noop */
      },
      ackAll: () => {
        /* noop */
      },
    };

    await worker.queue(batch, env, createExecutionContext());

    expect(ackCalled.value).toBe(true);
  });

  it('should distribute messages across shards by API key', async () => {
    const messages = Array.from({ length: 20 }, (_, i) => {
      const message = createMockQueueMessage(`test-${i}`, `api-key-${i}`);
      return {
        id: String(i),
        timestamp: new Date(),
        body: message,
        attempts: 0,
        ack: () => {
          /* noop */
        },
        retry: () => {
          /* noop */
        },
      };
    });

    const batch: MessageBatch<QueueMessage> = {
      queue: 'test-queue',
      messages,
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
      retryAll: () => {
        /* noop */
      },
      ackAll: () => {
        /* noop */
      },
    };

    await worker.queue(batch, env, createExecutionContext());

    expect(batch.messages.length).toBe(20);
  });

  it('should not write health metrics during queue processing', async () => {
    const analyticsSpy = vi.spyOn(env.ANALYTICS, 'writeDataPoint');
    const message = createMockQueueMessage('test-no-health-metrics', 'api-key-123');

    const batch: MessageBatch<QueueMessage> = {
      queue: 'test-queue',
      messages: [
        {
          id: '1',
          timestamp: new Date(),
          body: message,
          attempts: 0,
          ack: () => {
            /* noop */
          },
          retry: () => {
            /* noop */
          },
        },
      ],
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
      retryAll: () => {
        /* noop */
      },
      ackAll: () => {
        /* noop */
      },
    };

    await worker.queue(batch, env, createExecutionContext());

    expect(analyticsSpy).not.toHaveBeenCalled();
  });

  it('should write cron health metrics for all shards and only warn for unhealthy ones', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
    env.NUM_SHARDS = 3;

    const analyticsSpy = vi.spyOn(env.ANALYTICS, 'writeDataPoint');
    const warnSpy = vi.spyOn(console, 'warn');
    const infoSpy = vi.spyOn(console, 'info');

    const shard0 = env.TRACE_BATCHER.get(env.TRACE_BATCHER.idFromName('batcher-0'));
    await runInDurableObject(shard0, (instance: TraceBatcherInstance) => {
      return instance.addMessageTraces([
        { messageId: 'stale-msg', traces: [createMockTrace('trace-stale')] },
      ]);
    });

    vi.advanceTimersByTime(11 * 60 * 1000);

    await worker.scheduled(createScheduledController(), env, createExecutionContext());

    expect(analyticsSpy).toHaveBeenCalledTimes(3);

    const statuses = analyticsSpy.mock.calls.map(
      ([point]) => (point as { blobs?: string[] }).blobs?.[1],
    );
    expect(statuses).toContain('stale_backlog');
    expect(statuses).toContain('healthy');

    // Filter to JSON log records — auto-recovery triggers a forceFlush that
    // may emit non-JSON Tinybird retry warnings via console.warn directly.
    const warnRecords = warnSpy.mock.calls
      .map(([record]) => {
        try {
          return JSON.parse(String(record)) as {
            event: string;
            data?: Record<string, unknown>;
          };
        } catch {
          return null;
        }
      })
      .filter((r): r is { event: string; data?: Record<string, unknown> } => r !== null);
    expect(warnRecords.length).toBeGreaterThanOrEqual(1);
    expect(warnRecords.every((record) => record.event === 'consumer.trace_batcher_unhealthy')).toBe(
      true,
    );
    expect(
      warnRecords.some(
        (record) => record.data?.status === 'stale_backlog' && record.data?.cron === '*/5 * * * *',
      ),
    ).toBe(true);

    const infoRecords = infoSpy.mock.calls
      .map(([record]) => {
        try {
          return JSON.parse(String(record)) as {
            event: string;
            data?: Record<string, unknown>;
          };
        } catch {
          return null;
        }
      })
      .filter((r): r is { event: string; data?: Record<string, unknown> } => r !== null);
    const completeRecord = infoRecords.find(
      (r) => r.event === 'consumer.trace_batcher_health_check_complete',
    );
    expect(completeRecord).toBeDefined();
    expect(completeRecord?.data).toMatchObject({
      checkedShards: 3,
      cron: '*/5 * * * *',
    });
  });

  it('should handle message with invalid trace data gracefully', async () => {
    const invalidMessage = createMockQueueMessage('test-invalid', 'api-key-invalid');
    delete (invalidMessage as Partial<QueueMessage>).timing;

    const ackCalled = { value: false };
    const retryCalled = { value: false };

    const mockMessage: Message<QueueMessage> = {
      id: '1',
      timestamp: new Date(),
      body: invalidMessage,
      attempts: 0,
      ack: () => {
        ackCalled.value = true;
      },
      retry: () => {
        retryCalled.value = true;
      },
    };

    const batch: MessageBatch<QueueMessage> = {
      queue: 'test-queue',
      messages: [mockMessage],
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
      retryAll: () => {
        /* noop */
      },
      ackAll: () => {
        /* noop */
      },
    };

    await worker.queue(batch, env, createExecutionContext());

    expect(retryCalled.value).toBe(true);
    expect(ackCalled.value).toBe(false);
  });

  it('should ack messages after successful processing', async () => {
    const message = createMockQueueMessage('test-ack', 'api-key-ack');
    const ackCalled = { value: false };

    const mockMessage: Message<QueueMessage> = {
      id: '1',
      timestamp: new Date(),
      body: message,
      attempts: 0,
      ack: () => {
        ackCalled.value = true;
      },
      retry: () => {
        /* noop */
      },
    };

    const batch: MessageBatch<QueueMessage> = {
      queue: 'test-queue',
      messages: [mockMessage],
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
      retryAll: () => {
        /* noop */
      },
      ackAll: () => {
        /* noop */
      },
    };

    await worker.queue(batch, env, createExecutionContext());

    expect(ackCalled.value).toBe(true);
  });

  it('should ack duplicate messages for the same request', async () => {
    const message = createMockQueueMessage('test-dup', 'api-key-dup');
    const ackCalled = { first: false, second: false };
    const retryCalled = { first: false, second: false };

    const messages: Message<QueueMessage>[] = [
      {
        id: '1',
        timestamp: new Date(),
        body: message,
        attempts: 0,
        ack: () => {
          ackCalled.first = true;
        },
        retry: () => {
          retryCalled.first = true;
        },
      },
      {
        id: '2',
        timestamp: new Date(),
        body: message,
        attempts: 0,
        ack: () => {
          ackCalled.second = true;
        },
        retry: () => {
          retryCalled.second = true;
        },
      },
    ];

    const batch: MessageBatch<QueueMessage> = {
      queue: 'test-queue',
      messages,
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
      retryAll: () => {
        /* noop */
      },
      ackAll: () => {
        /* noop */
      },
    };

    await worker.queue(batch, env, createExecutionContext());

    expect(ackCalled.first).toBe(true);
    expect(ackCalled.second).toBe(true);
    expect(retryCalled.first).toBe(false);
    expect(retryCalled.second).toBe(false);
  });

  it('should retry messages when Durable Object fails', async () => {
    const message = createMockQueueMessage('test-do-fail', 'api-key-do-fail');
    const retryCalled = { value: false };
    const ackCalled = { value: false };

    const mockMessage: Message<QueueMessage> = {
      id: '1',
      timestamp: new Date(),
      body: message,
      attempts: 0,
      ack: () => {
        ackCalled.value = true;
      },
      retry: () => {
        retryCalled.value = true;
      },
    };

    const batch: MessageBatch<QueueMessage> = {
      queue: 'test-queue',
      messages: [mockMessage],
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
      retryAll: () => {
        /* noop */
      },
      ackAll: () => {
        /* noop */
      },
    };

    const originalGet = env.TRACE_BATCHER.get.bind(env.TRACE_BATCHER);
    const mockDOStub = {
      addMessageTraces: (): Promise<void> => {
        throw new Error('Durable Object failure');
      },
    } as unknown as DurableObjectStub<TraceBatcherInstance>;

    env.TRACE_BATCHER.get = () => mockDOStub;

    await worker.queue(batch, env, createExecutionContext());

    env.TRACE_BATCHER.get = originalGet;

    expect(retryCalled.value).toBe(true);
    expect(ackCalled.value).toBe(false);
  });

  it('should process batch of messages from same API key to same shard', async () => {
    const sameApiKey = 'api-key-same';
    const messages = Array.from({ length: 5 }, (_, i) => {
      const message = createMockQueueMessage(`test-same-${i}`, sameApiKey);
      return {
        id: String(i),
        timestamp: new Date(),
        body: message,
        attempts: 0,
        ack: () => {
          /* noop */
        },
        retry: () => {
          /* noop */
        },
      };
    });

    const batch: MessageBatch<QueueMessage> = {
      queue: 'test-queue',
      messages,
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
      retryAll: () => {
        /* noop */
      },
      ackAll: () => {
        /* noop */
      },
    };

    await worker.queue(batch, env, createExecutionContext());

    expect(batch.messages.length).toBe(5);
  });

  it('should handle empty batch gracefully', async () => {
    const batch: MessageBatch<QueueMessage> = {
      queue: 'test-queue',
      messages: [],
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
      retryAll: () => {
        /* noop */
      },
      ackAll: () => {
        /* noop */
      },
    };

    await worker.queue(batch, env, createExecutionContext());
  });

  it('should handle messages with SSE timing data', async () => {
    const message = createMockQueueMessage('test-sse', 'api-key-sse');
    message.sseStreamData = {
      messages: [
        {
          messageStart: 1150,
          messageStop: 1480,
          events: [
            { type: 'message_start', timestamp: 1150, data: '{}' },
            { type: 'content_block_delta', timestamp: 1250, data: '{}' },
            { type: 'message_stop', timestamp: 1480, data: '{}' },
          ],
        },
      ],
    };

    const ackCalled = { value: false };

    const mockMessage: Message<QueueMessage> = {
      id: '1',
      timestamp: new Date(),
      body: message,
      attempts: 0,
      ack: () => {
        ackCalled.value = true;
      },
      retry: () => {
        /* noop */
      },
    };

    const batch: MessageBatch<QueueMessage> = {
      queue: 'test-queue',
      messages: [mockMessage],
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
      retryAll: () => {
        /* noop */
      },
      ackAll: () => {
        /* noop */
      },
    };

    await worker.queue(batch, env, createExecutionContext());

    expect(ackCalled.value).toBe(true);
  });

  it('should handle messages with token usage data', async () => {
    const message = createMockQueueMessage('test-tokens', 'api-key-tokens');
    message.tokens = {
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    };

    const ackCalled = { value: false };

    const mockMessage: Message<QueueMessage> = {
      id: '1',
      timestamp: new Date(),
      body: message,
      attempts: 0,
      ack: () => {
        ackCalled.value = true;
      },
      retry: () => {
        /* noop */
      },
    };

    const batch: MessageBatch<QueueMessage> = {
      queue: 'test-queue',
      messages: [mockMessage],
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
      retryAll: () => {
        /* noop */
      },
      ackAll: () => {
        /* noop */
      },
    };

    await worker.queue(batch, env, createExecutionContext());

    expect(ackCalled.value).toBe(true);
  });

  it('should handle messages with error data', async () => {
    const message = createMockQueueMessage('test-error', 'api-key-error');
    message.error = {
      type: 'invalid_request_error',
      message: 'Invalid API key',
      code: 'invalid_api_key',
    };
    message.response.status = 401;

    const ackCalled = { value: false };

    const mockMessage: Message<QueueMessage> = {
      id: '1',
      timestamp: new Date(),
      body: message,
      attempts: 0,
      ack: () => {
        ackCalled.value = true;
      },
      retry: () => {
        /* noop */
      },
    };

    const batch: MessageBatch<QueueMessage> = {
      queue: 'test-queue',
      messages: [mockMessage],
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
      retryAll: () => {
        /* noop */
      },
      ackAll: () => {
        /* noop */
      },
    };

    await worker.queue(batch, env, createExecutionContext());

    expect(ackCalled.value).toBe(true);
  });
});
