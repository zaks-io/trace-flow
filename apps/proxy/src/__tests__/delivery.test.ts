import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '@trace-flow/logging';
import type { OTLPQueueMessage } from '@trace-flow/types';
import { isEncryptedStoredBodiesPayload } from '@trace-flow/types';
import { decryptStoredBodyPayload } from '@trace-flow/utils';
import {
  buildTraceDeliveryEnvelope,
  enqueueTraceDelivery,
  persistTraceDelivery,
  sweepTraceDeliveries,
} from '../delivery';

const ROOT_KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
const noopLogger: Logger = {
  child: () => noopLogger,
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  flush: async () => {},
};

const otlpMessage: OTLPQueueMessage = {
  type: 'otlp',
  apiKey: 'tf_test',
  traces: [],
  receivedAt: 1,
};

describe('trace delivery producer', () => {
  it('encrypts bodies for their canonical key before building the envelope', async () => {
    const envelope = await buildTraceDeliveryEnvelope(
      {
        requestId: 'request-id',
        apiKey: 'tf_test',
        targetUrl: 'https://api.openai.com/v1/chat/completions',
        request: {
          id: 'request-id',
          provider: 'openai',
          model: 'gpt-4o',
          messages: [],
          timestamp: 1,
        },
        response: {
          id: 'request-id',
          provider: 'openai',
          status: 200,
          timestamp: 2,
          latency: 1,
        },
        timing: { requestStart: 1, requestSent: 1, responseReceived: 2, responseComplete: 2 },
        receivedAt: 1_000_000,
        orgId: 'org-1',
      },
      {
        requestId: 'request-id',
        requestBody: 'private request',
        responseBody: 'private response',
        truncated: false,
        orgId: 'org-1',
        encryption: { rootKeyBase64: ROOT_KEY, keyId: 'v1' },
      },
    );

    expect(JSON.stringify(envelope)).not.toContain('private request');
    expect(JSON.stringify(envelope)).not.toContain('private response');
    expect(envelope.body?.key).toBe('bodies/request-id');
    expect(isEncryptedStoredBodiesPayload(envelope.body?.encryptedPayload)).toBe(true);
    await expect(
      decryptStoredBodyPayload(envelope.body!.encryptedPayload, {
        rootKeyBase64: ROOT_KEY,
        orgId: 'org-1',
        objectKey: 'bodies/request-id',
      }),
    ).resolves.toContain('private response');
  });

  it('writes the immutable envelope before queueing its small reference', async () => {
    const order: string[] = [];
    const storage = {
      put: vi.fn(async (_key: string, _value: string, options: R2PutOptions) => {
        order.push('put');
        expect(options.onlyIf).toEqual({ etagDoesNotMatch: '*' });
        return { key: 'stored' };
      }),
    } as unknown as R2Bucket;
    const queue = {
      send: vi.fn(async () => {
        order.push('send');
      }),
    } as unknown as Queue<OTLPQueueMessage>;

    const envelope = await buildTraceDeliveryEnvelope(otlpMessage);
    const key = await persistTraceDelivery(storage, envelope, 'dev');
    await enqueueTraceDelivery(queue as never, key, otlpMessage);

    expect(order).toEqual(['put', 'send']);
    expect(queue.send).toHaveBeenCalledWith({ type: 'delivery', key });
  });

  it('leaves the durable envelope available when queue send fails', async () => {
    const persisted = new Map<string, string>();
    const storage = {
      put: vi.fn(async (key: string, value: string) => {
        persisted.set(key, value);
        return { key };
      }),
      list: vi.fn(async () => ({
        objects: [...persisted.keys()].map((key) => ({ key, uploaded: new Date(1) })),
        truncated: false,
      })),
    } as unknown as R2Bucket;
    const queue = {
      send: vi
        .fn()
        .mockRejectedValueOnce(new Error('queue unavailable'))
        .mockResolvedValue(undefined),
    };

    const key = await persistTraceDelivery(
      storage,
      await buildTraceDeliveryEnvelope(otlpMessage),
      'dev',
    );
    await expect(enqueueTraceDelivery(queue as never, key, otlpMessage)).rejects.toThrow(
      'queue unavailable',
    );
    expect(JSON.parse(persisted.get(key) ?? '')).toEqual({ version: 1, message: otlpMessage });
    await expect(
      sweepTraceDeliveries(storage, queue as never, noopLogger, 'dev', 600_001),
    ).resolves.toBe(1);
    expect(queue.send).toHaveBeenLastCalledWith({ type: 'delivery', key });
  });

  it('fails when the initial durable write is not accepted', async () => {
    const unavailable = {
      put: vi.fn().mockRejectedValue(new Error('R2 unavailable')),
    } as unknown as R2Bucket;
    const collision = {
      put: vi.fn().mockResolvedValue(null),
    } as unknown as R2Bucket;
    const envelope = await buildTraceDeliveryEnvelope(otlpMessage);

    await expect(persistTraceDelivery(unavailable, envelope, 'dev')).rejects.toThrow(
      'R2 unavailable',
    );
    await expect(persistTraceDelivery(collision, envelope, 'dev')).rejects.toThrow('key collision');
    await expect(persistTraceDelivery(collision, envelope, '')).rejects.toThrow(
      'namespace must be a non-empty path-safe identifier',
    );
    await expect(
      persistTraceDelivery(collision, envelope, undefined as unknown as string),
    ).rejects.toThrow('namespace must be a non-empty path-safe identifier');
  });

  it('stores a large OTLP export while queueing only a small reference', async () => {
    const largeMessage: OTLPQueueMessage = {
      type: 'otlp',
      apiKey: 'tf_large',
      receivedAt: 1,
      traces: [
        {
          ReceivedAt: 1,
          Timestamp: 1,
          TraceId: 'trace',
          SpanId: 'span',
          ParentSpanId: '',
          TraceState: '',
          SpanName: 'large',
          SpanKind: 'SPAN_KIND_INTERNAL',
          ServiceName: 'test',
          ResourceAttributes: {},
          SpanAttributes: { payload: 'x'.repeat(200_000) },
          Duration: 1,
          StatusCode: 'STATUS_CODE_OK',
          StatusMessage: '',
          ApiKey: 'tf_large',
          'Events.Timestamp': [],
          'Events.Name': [],
          'Events.Attributes': [],
          'Links.TraceId': [],
          'Links.SpanId': [],
          'Links.TraceState': [],
          'Links.Attributes': [],
          TierAtIngestion: 'pro',
          RetentionExpiresAt: 2,
        },
      ],
    };
    let storedBytes = 0;
    const storage = {
      put: vi.fn(async (_key: string, value: string) => {
        storedBytes = value.length;
        return { key: 'stored' };
      }),
    } as unknown as R2Bucket;
    let queuedBytes = 0;
    const queue = {
      send: vi.fn(async (value: unknown) => {
        queuedBytes = JSON.stringify(value).length;
      }),
    };

    const key = await persistTraceDelivery(
      storage,
      await buildTraceDeliveryEnvelope(largeMessage),
      'dev',
    );
    await enqueueTraceDelivery(queue as never, key, largeMessage);

    expect(storedBytes).toBeGreaterThan(200_000);
    expect(queuedBytes).toBeLessThan(200);
  });

  it('paginates through the full outbox and skips recent objects', async () => {
    const old = new Date(1_000);
    const recent = new Date(600_000);
    const storage = {
      list: vi
        .fn()
        .mockResolvedValueOnce({
          objects: [{ key: 'trace-deliveries/first', uploaded: old }],
          truncated: true,
          cursor: 'next',
        })
        .mockResolvedValueOnce({
          objects: [
            { key: 'trace-deliveries/second', uploaded: old },
            { key: 'trace-deliveries/recent', uploaded: recent },
          ],
          truncated: false,
        }),
    } as unknown as R2Bucket;
    const queue = { send: vi.fn().mockResolvedValue(undefined) };

    await expect(
      sweepTraceDeliveries(storage, queue as never, noopLogger, 'dev', 601_000),
    ).resolves.toBe(2);
    expect(storage.list).toHaveBeenNthCalledWith(2, {
      prefix: 'trace-deliveries/dev-',
      limit: 1_000,
      cursor: 'next',
    });
    expect(queue.send).toHaveBeenCalledWith({
      type: 'delivery',
      key: 'trace-deliveries/second',
    });
    expect(queue.send).not.toHaveBeenCalledWith({
      type: 'delivery',
      key: 'trace-deliveries/recent',
    });
  });

  it('isolates scheduled sweeps by producer environment', async () => {
    const objects = [
      { key: 'trace-deliveries/dev-first', uploaded: new Date(1) },
      { key: 'trace-deliveries/preview-first', uploaded: new Date(1) },
    ];
    const storage = {
      list: vi.fn(async ({ prefix }: R2ListOptions) => ({
        objects: objects.filter((object) => object.key.startsWith(prefix ?? '')),
        truncated: false,
      })),
    } as unknown as R2Bucket;
    const devQueue = { send: vi.fn().mockResolvedValue(undefined) };
    const previewQueue = { send: vi.fn().mockResolvedValue(undefined) };

    await sweepTraceDeliveries(storage, devQueue as never, noopLogger, 'dev', 600_001);
    await sweepTraceDeliveries(storage, previewQueue as never, noopLogger, 'preview', 600_001);

    expect(devQueue.send).toHaveBeenCalledTimes(1);
    expect(devQueue.send).toHaveBeenCalledWith({
      type: 'delivery',
      key: 'trace-deliveries/dev-first',
    });
    expect(previewQueue.send).toHaveBeenCalledTimes(1);
    expect(previewQueue.send).toHaveBeenCalledWith({
      type: 'delivery',
      key: 'trace-deliveries/preview-first',
    });
  });

  it('bounds enqueue concurrency without limiting page progress', async () => {
    const storage = {
      list: vi.fn(async () => ({
        objects: Array.from({ length: 25 }, (_, index) => ({
          key: `trace-deliveries/dev-${index}`,
          uploaded: new Date(1),
        })),
        truncated: false,
      })),
    } as unknown as R2Bucket;
    let active = 0;
    let maxActive = 0;
    const queue = {
      send: vi.fn(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active--;
      }),
    };

    await expect(
      sweepTraceDeliveries(storage, queue as never, noopLogger, 'dev', 600_001),
    ).resolves.toBe(25);

    expect(queue.send).toHaveBeenCalledTimes(25);
    expect(maxActive).toBe(10);
  });
});
