import type { CloudflareOptions, Event } from '@sentry/cloudflare';
import type * as SentryCloudflare from '@sentry/cloudflare';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OTLPQueueMessage, QueueMessageUnion, TraceDeliveryEnvelope } from '@trace-flow/types';
import { buildTraceDeliveryKey } from '@trace-flow/utils';
import worker, { type Env } from '../index';
import type { TraceBatcherInstance } from '../batcher';
import { createMockTrace } from './fixtures';

const { events } = vi.hoisted(() => ({ events: [] as Event[] }));
const TRACE_A = '11111111111111111111111111111111';
const TRACE_B = '22222222222222222222222222222222';
const PARENT = '3333333333333333';

// Keep actual queue and continuation instrumentation, but capture envelopes locally.
// The batcher is unwrapped because this suite verifies consumer scope and durable handoff.
vi.mock('@sentry/cloudflare', async (importOriginal) => {
  const actual = await importOriginal<typeof SentryCloudflare>();
  const transport: NonNullable<CloudflareOptions['transport']> = () => ({
    send: async (envelope) => {
      for (const [header, payload] of envelope[1]) {
        if (header.type === 'transaction' || header.type === 'event') events.push(payload as Event);
      }
      return { statusCode: 200 };
    },
    flush: async () => true,
  });
  return {
    ...actual,
    instrumentDurableObjectWithSentry: <T>(_options: unknown, constructor: T): T => constructor,
    withSentry: ((options: (bindings: Env) => CloudflareOptions, handler: ExportedHandler<Env>) =>
      actual.withSentry(
        (bindings) => ({
          ...options(bindings),
          dsn: 'https://public@example.test/1',
          skipOpenTelemetrySetup: true,
          transport,
        }),
        handler,
      )) as typeof actual.withSentry,
  };
});

vi.mock('../tinybird', () => ({
  insertIntoTinybird: vi.fn().mockResolvedValue(undefined),
  insertIntoTinybirdWithRetry: vi.fn().mockResolvedValue(undefined),
}));

function queueMessage(id: string, body: QueueMessageUnion) {
  return {
    id,
    body,
    timestamp: new Date(),
    attempts: 0,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

async function deliver(messages: Message<QueueMessageUnion>[]) {
  const context = createExecutionContext();
  await worker.queue(
    {
      queue: 'trace-flow-requests-dev',
      messages,
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    },
    env,
    context,
  );
  await waitOnExecutionContext(context);
}

function payload(id: string, traceId: string): OTLPQueueMessage {
  return {
    type: 'otlp',
    apiKey: 'continuation-test-api-key',
    traces: [createMockTrace(id)],
    receivedAt: 1700000000000000000,
    sentry_trace_context: { 'sentry-trace': `${traceId}-${PARENT}-1` },
  };
}

async function storeEnvelope(id: string, traceId: string) {
  const key = buildTraceDeliveryKey(id);
  const envelope: TraceDeliveryEnvelope = { version: 1, message: payload(id, traceId) };
  await env.STORAGE.put(key, JSON.stringify(envelope));
  return key;
}

function processingEvents() {
  // The SDK batch root has the same name and op. Only continued transactions inherit this parent.
  return events.filter(
    (event) => event.type === 'transaction' && event.contexts?.trace?.parent_span_id === PARENT,
  );
}

describe('consumer authoritative envelope trace continuation', () => {
  beforeEach(() => {
    events.length = 0;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  it('continues context-free recovery references under their authoritative producer context', async () => {
    const keys = await Promise.all([
      storeEnvelope('continued-a1', TRACE_A),
      storeEnvelope('continued-b1', TRACE_B),
      storeEnvelope('continued-a2', TRACE_A),
    ]);
    const messages = keys.map((key, index) =>
      queueMessage(`recovery-${index}`, { type: 'delivery', key }),
    );
    const envelopesAtAck: Promise<R2ObjectBody | null>[] = [];
    messages.forEach((message, index) =>
      message.ack.mockImplementation(() => {
        envelopesAtAck.push(env.STORAGE.get(keys[index]!));
      }),
    );

    await deliver(messages);

    const processing = processingEvents();
    expect(processing).toHaveLength(3);
    expect(processing.map((event) => event.contexts?.trace?.trace_id).sort()).toEqual([
      TRACE_A,
      TRACE_A,
      TRACE_B,
    ]);
    for (const event of processing) expect(event.contexts?.trace?.parent_span_id).toBe(PARENT);
    for (const event of processing)
      expect(event.contexts?.trace?.data?.['messaging.batch.message_count']).toBe(1);
    for (const message of messages) {
      expect(message.ack).toHaveBeenCalledOnce();
      expect(message.retry).not.toHaveBeenCalled();
    }
    expect(await Promise.all(envelopesAtAck)).toEqual([null, null, null]);
    for (const key of keys) expect(await env.STORAGE.get(key)).toBeNull();
  });

  it('retains the continued envelope and retries when durable staging fails', async () => {
    const key = await storeEnvelope('continuation-stage-failure', TRACE_A);
    const message = queueMessage('stage-failure', { type: 'delivery', key });
    vi.spyOn(env.TRACE_BATCHER, 'get').mockReturnValue({
      addMessageTraces: vi.fn().mockRejectedValue(new Error('Durable staging failed')),
    } as unknown as DurableObjectStub<TraceBatcherInstance>);

    await deliver([message]);

    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledOnce();
    expect(await env.STORAGE.get(key)).not.toBeNull();
    expect(processingEvents()).toHaveLength(1);
    expect(processingEvents()[0]?.contexts?.trace?.trace_id).toBe(TRACE_A);
  });

  it('captures body-copy failure under the producer scope and keeps the envelope for retry', async () => {
    const key = buildTraceDeliveryKey('scoped-body-failure');
    const requestId = 'scoped-body-failure';
    const envelope: TraceDeliveryEnvelope = {
      version: 1,
      message: {
        requestId,
        apiKey: 'continuation-test-api-key',
        orgId: 'org-test',
        targetUrl: 'https://api.openai.com/v1/chat/completions',
        request: {
          id: requestId,
          provider: 'openai',
          model: 'gpt-4',
          messages: [],
          timestamp: 1000,
        },
        response: { id: requestId, provider: 'openai', status: 200, timestamp: 1500, latency: 500 },
        timing: {
          requestStart: 1000,
          requestSent: 1100,
          responseReceived: 1150,
          responseComplete: 1500,
        },
        receivedAt: 1700000000000000000,
        sentry_trace_context: { 'sentry-trace': `${TRACE_A}-${PARENT}-1` },
      },
      body: {
        key: `bodies/${requestId}`,
        orgId: 'org-test',
        encryptedPayload: {
          v: 1,
          alg: 'AES-GCM',
          kdf: 'HKDF-SHA-256',
          kid: 'test',
          orgId: 'org-test',
          iv: 'iv',
          data: 'encrypted',
        },
      },
    };
    await env.STORAGE.put(key, JSON.stringify(envelope));
    vi.spyOn(env.STORAGE, 'put').mockRejectedValueOnce(new Error('Private body details'));
    const message = queueMessage('scoped-copy-failure', { type: 'delivery', key });

    await deliver([message]);

    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledOnce();
    expect(await env.STORAGE.get(key)).not.toBeNull();
    expect(await env.STORAGE.get(`bodies/${requestId}`)).toBeNull();
    const errorEvent = events.find((event) => event.tags?.operation === 'consumer.message_process');
    expect(errorEvent?.contexts?.trace?.trace_id).toBe(TRACE_A);
    expect(errorEvent?.contexts?.trace?.span_id).toBe(
      processingEvents()[0]?.contexts?.trace?.span_id,
    );
    expect(JSON.stringify(errorEvent)).not.toContain('Private body details');
  });

  it('uses stored producer identity when the queue reference carries a conflicting context', async () => {
    const key = await storeEnvelope('authoritative-context', TRACE_A);
    const message = queueMessage('conflicting-reference', {
      type: 'delivery',
      key,
      sentry_trace_context: { 'sentry-trace': `${TRACE_B}-${PARENT}-1` },
    });

    await deliver([message]);

    expect(processingEvents()).toHaveLength(1);
    expect(processingEvents()[0]?.contexts?.trace?.trace_id).toBe(TRACE_A);
    expect(message.ack).toHaveBeenCalledOnce();
  });

  it('retains producer grouping for inline payloads from mixed producers', async () => {
    const messages = [
      queueMessage('inline-a1', payload('inline-a1', TRACE_A)),
      queueMessage('inline-b1', payload('inline-b1', TRACE_B)),
      queueMessage('inline-a2', payload('inline-a2', TRACE_A)),
    ];

    await deliver(messages);

    const processing = processingEvents();
    expect(processing).toHaveLength(2);
    expect(processing.map((event) => event.contexts?.trace?.trace_id).sort()).toEqual([
      TRACE_A,
      TRACE_B,
    ]);
    expect(
      processing.find((event) => event.contexts?.trace?.trace_id === TRACE_A)?.contexts?.trace
        ?.data?.['messaging.batch.message_count'],
    ).toBe(2);
    expect(
      processing.find((event) => event.contexts?.trace?.trace_id === TRACE_B)?.contexts?.trace
        ?.data?.['messaging.batch.message_count'],
    ).toBe(1);
    for (const message of messages) expect(message.ack).toHaveBeenCalledOnce();
  });

  it('acknowledges a removed recovery envelope without inventing a producer continuation', async () => {
    const message = queueMessage('missing-recovery', {
      type: 'delivery',
      key: buildTraceDeliveryKey('already-completed'),
    });

    await deliver([message]);

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(processingEvents()).toHaveLength(0);
  });
});
