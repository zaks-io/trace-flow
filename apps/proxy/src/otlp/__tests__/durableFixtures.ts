import { createExecutionContext } from 'cloudflare:test';
import { vi } from 'vitest';
import type { ProxyEnv } from '../../context';
import { analyticsKeyId } from '@trace-flow/utils';
import { app } from '../../index';
import type { OTLPExportTraceServiceRequest } from '../types';
import { Writer, WIRE_LEN } from '../wire';

export const API_KEY = 'otlp-durable-test-key';

export function makeEnv(options?: {
  storageError?: Error;
  usageError?: Error;
  subscriptionStatus?: string;
}) {
  let storedValue = '';
  const queueSend = vi.fn().mockResolvedValue(undefined);
  const storagePut = options?.storageError
    ? vi.fn().mockRejectedValue(options.storageError)
    : vi.fn(async (_key: string, value: string) => {
        storedValue = value;
        return { key: 'stored' };
      });
  const usageGet = vi.fn(() => ({
    fetch: options?.usageError
      ? vi.fn().mockRejectedValue(options.usageError)
      : vi.fn(async () => Response.json({ allowed: true })),
  }));
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
          return JSON.stringify({
            tier: 'pro',
            status: options?.subscriptionStatus ?? 'active',
            monthlyUnits: 1_000_000,
          });
        }
        return null;
      }),
    },
    USAGE_TRACKER: {
      idFromName: vi.fn(() => 'id'),
      get: usageGet,
    },
    ORG_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
    IP_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
    ANALYTICS: { writeDataPoint: vi.fn() },
    CONVEX_SITE_URL: 'https://example.convex.site',
    USAGE_SYNC_SECRET: 'test',
    TRACE_DELIVERY_NAMESPACE: 'dev',
    BODY_ENCRYPTION_ROOT_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
  } as unknown as ProxyEnv;
  return { env, queueSend, storagePut, usageGet, getStoredValue: () => storedValue };
}

export function otlpBody(attributeValue = 'value'): OTLPExportTraceServiceRequest {
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

export async function postOTLP(env: ProxyEnv, body: unknown) {
  return postRawOTLP(env, JSON.stringify(body), 'application/json');
}

export async function postRawOTLP(
  env: ProxyEnv,
  body: BodyInit,
  contentType: string,
  contentEncoding?: string,
  headers: Record<string, string> = {},
) {
  const ctx = createExecutionContext();
  const response = await app.request(
    '/v1/traces',
    {
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        'X-Trace-Flow-Api-Key': API_KEY,
        ...(contentEncoding ? { 'Content-Encoding': contentEncoding } : {}),
        ...headers,
      },
      body,
    },
    env,
    ctx,
  );
  return { response, ctx };
}

export function compactSpanFlood(): Uint8Array {
  const top = new Writer();
  top.tag(1, WIRE_LEN).message((resource) => {
    resource.tag(2, WIRE_LEN).message((scope) => {
      for (let index = 0; index < 5_001; index += 1) {
        scope.tag(2, WIRE_LEN).message(() => undefined);
      }
    });
  });
  return top.toUint8Array();
}
