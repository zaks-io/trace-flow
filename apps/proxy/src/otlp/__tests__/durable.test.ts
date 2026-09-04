import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProxyEnv } from '../../context';
import { analyticsKeyId } from '@trace-flow/utils';
import { app } from '../../index';
import { _clearUsageCache } from '../../usage';

const API_KEY = 'otlp-durable-test-key';

function makeEnv(options?: { storageError?: Error; usageError?: Error }) {
  let storedValue = '';
  const queueSend = vi.fn().mockResolvedValue(undefined);
  const storagePut = options?.storageError
    ? vi.fn().mockRejectedValue(options.storageError)
    : vi.fn(async (_key: string, value: string) => {
        storedValue = value;
        return { key: 'stored' };
      });
  const env = {
    REQUEST_QUEUE: { send: queueSend },
    STORAGE: { put: storagePut },
    API_KEYS: {
      get: vi.fn(async (key: string) => {
        if (key === API_KEY) {
          return JSON.stringify({
            expiresAt: Date.now() + 60_000,
            createdAt: 1,
            orgId: 'org-otlp',
            analyticsKeyId: await analyticsKeyId(API_KEY),
          });
        }
        if (key === 'sub:org-otlp') {
          return JSON.stringify({ tier: 'pro', status: 'active', monthlyUnits: 1_000_000 });
        }
        return null;
      }),
    },
    USAGE_TRACKER: {
      idFromName: vi.fn(() => 'id'),
      get: vi.fn(() => ({
        fetch: options?.usageError
          ? vi.fn().mockRejectedValue(options.usageError)
          : vi.fn().mockResolvedValue(Response.json({ allowed: true })),
      })),
    },
    ORG_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
    IP_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
    ANALYTICS: { writeDataPoint: vi.fn() },
    CONVEX_SITE_URL: 'https://example.convex.site',
    USAGE_SYNC_SECRET: 'test',
    TRACE_DELIVERY_NAMESPACE: 'dev',
  } as unknown as ProxyEnv;
  return { env, queueSend, storagePut, getStoredValue: () => storedValue };
}

function otlpBody(attributeValue = 'value') {
  return {
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: [
              {
                traceId: '0123456789abcdef0123456789abcdef',
                spanId: '0123456789abcdef',
                name: 'durable-test',
                startTimeUnixNano: '1000000000',
                endTimeUnixNano: '2000000000',
                attributes: [{ key: 'large.value', value: { stringValue: attributeValue } }],
              },
            ],
          },
        ],
      },
    ],
  };
}

async function postOTLP(env: ProxyEnv, body: unknown) {
  const ctx = createExecutionContext();
  const response = await app.request(
    '/v1/traces',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Trace-Flow-Api-Key': API_KEY,
      },
      body: JSON.stringify(body),
    },
    env,
    ctx,
  );
  return { response, ctx };
}

describe('OTLP durable acceptance', () => {
  beforeEach(() => _clearUsageCache());

  it('returns retryable 503 when the initial outbox write fails', async () => {
    const { env, queueSend } = makeEnv({ storageError: new Error('R2 unavailable') });
    const { response, ctx } = await postOTLP(env, otlpBody());

    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('1');
    expect(queueSend).not.toHaveBeenCalled();
    await waitOnExecutionContext(ctx);
  });

  it('returns retryable 503 for an internal recording decision error', async () => {
    const { env, storagePut, queueSend } = makeEnv({
      usageError: new Error('usage tracker unavailable'),
    });
    const { response, ctx } = await postOTLP(env, otlpBody());

    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('1');
    expect(storagePut).not.toHaveBeenCalled();
    expect(queueSend).not.toHaveBeenCalled();
    await waitOnExecutionContext(ctx);
  });

  it('accepts a 200KB export and queues only its delivery reference', async () => {
    const { env, queueSend, getStoredValue } = makeEnv();
    const { response, ctx } = await postOTLP(env, otlpBody('x'.repeat(200_000)));

    expect(response.status).toBe(200);
    const storedValue = getStoredValue();
    expect(storedValue.length).toBeGreaterThan(200_000);
    const envelope = JSON.parse(storedValue);
    const identifier = await analyticsKeyId(API_KEY);
    expect(envelope.message.apiKey).toBe(identifier);
    expect(envelope.message.traces[0].ApiKey).toBe(identifier);
    expect(storedValue).not.toContain(API_KEY);
    await waitOnExecutionContext(ctx);
    expect(queueSend).toHaveBeenCalledTimes(1);
    const reference = queueSend.mock.calls[0]?.[0];
    expect(reference).toMatchObject({ type: 'delivery' });
    expect(JSON.stringify(reference).length).toBeLessThan(200);
  });
});
