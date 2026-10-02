import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProxyEnv } from '../../context';
import { analyticsKeyId } from '@trace-flow/utils';
import { app } from '../../index';
import { _clearUsageCache } from '../../usage';
import type { OTLPExportTraceServiceRequest } from '../types';
import { Writer, WIRE_LEN } from '../wire';
import { GEN_AI_USAGE, SOURCE_IMPORTED_EXECUTION, TRACE_FLOW } from '@trace-flow/otel-conventions';
import importedFixture from '../../../../../fixtures/cliproxyapi-execution-v2.json';

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
  const usageGet = vi.fn(() => ({
    fetch: options?.usageError
      ? vi.fn().mockRejectedValue(options.usageError)
      : vi.fn().mockResolvedValue(Response.json({ allowed: true })),
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
          return JSON.stringify({ tier: 'pro', status: 'active', monthlyUnits: 1_000_000 });
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

function otlpBody(attributeValue = 'value'): OTLPExportTraceServiceRequest {
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
  return postRawOTLP(env, JSON.stringify(body), 'application/json');
}

async function postRawOTLP(
  env: ProxyEnv,
  body: BodyInit,
  contentType: string,
  contentEncoding?: string,
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
      },
      body,
    },
    env,
    ctx,
  );
  return { response, ctx };
}

function compactSpanFlood(): Uint8Array {
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

describe('OTLP durable acceptance', () => {
  beforeEach(() => {
    _clearUsageCache();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          authorized: true,
          expiresAt: Date.now() + 60_000,
          createdAt: 1,
          orgId: 'org-otlp',
        }),
      ),
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

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

  it('rejects resource attributes whose per-span expansion exceeds the delivery budget', async () => {
    const { env, storagePut, queueSend } = makeEnv();
    const body = otlpBody();
    body.resourceSpans[0]!.resource = {
      attributes: [{ key: 'shared', value: { stringValue: 'x'.repeat(100_000) } }],
    };
    body.resourceSpans[0]!.scopeSpans[0]!.spans = Array.from({ length: 100 }, (_, index) => ({
      ...body.resourceSpans[0]!.scopeSpans[0]!.spans[0]!,
      spanId: (index + 1).toString(16).padStart(16, '0'),
    }));

    const { response, ctx } = await postOTLP(env, body);

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: 413 } });
    expect(storagePut).not.toHaveBeenCalled();
    expect(queueSend).not.toHaveBeenCalled();
    await waitOnExecutionContext(ctx);
  });

  it('logs only OTLP counts, never supplied names, keys, or values', async () => {
    const secretValue = 'customer-secret-value-that-must-not-be-logged';
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { env } = makeEnv();
    const { response, ctx } = await postOTLP(env, otlpBody(secretValue));

    expect(response.status).toBe(200);
    await waitOnExecutionContext(ctx);
    const logs = info.mock.calls.flat().join('\n');
    expect(logs).toContain('"spanCount":1');
    expect(logs).not.toContain('durable-test');
    expect(logs).not.toContain('large.value');
    expect(logs).not.toContain(secretValue);
  });

  it('does not log malformed JSON fragments', async () => {
    const canary = 'UNTRUSTED_JSON_CANARY';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { env } = makeEnv();
    const { response, ctx } = await postRawOTLP(env, `{"secret":"${canary}"`, 'application/json');

    expect(response.status).toBe(400);
    await waitOnExecutionContext(ctx);
    expect(warn.mock.calls.flat().join('\n')).not.toContain(canary);
  });

  it('classifies unexpected body-processing failures as internal errors', async () => {
    vi.stubGlobal(
      'DecompressionStream',
      class {
        constructor() {
          throw new Error('decompression runtime unavailable');
        }
      },
    );
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { env } = makeEnv();
    const { response, ctx } = await postRawOTLP(
      env,
      new Uint8Array([1, 2, 3]),
      'application/json',
      'gzip',
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: 500, message: 'Failed to process request body' },
    });
    await waitOnExecutionContext(ctx);
    expect(errorLog.mock.calls.flat().join('\n')).toContain('otlp.input_internal_failed');
  });

  it('rejects compact protobuf span floods before recording or storage', async () => {
    const { env, usageGet, storagePut, queueSend } = makeEnv();
    const { response, ctx } = await postRawOTLP(env, compactSpanFlood(), 'application/x-protobuf');

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: 413 } });
    expect(usageGet).not.toHaveBeenCalled();
    expect(storagePut).not.toHaveBeenCalled();
    expect(queueSend).not.toHaveBeenCalled();
    await waitOnExecutionContext(ctx);
  });
  it('rejects an unauthenticated imported export before durable storage', async () => {
    const { env, storagePut, queueSend } = makeEnv();
    const ctx = createExecutionContext();
    const response = await app.request(
      '/v1/traces',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(importedFixture),
      },
      env,
      ctx,
    );
    expect(response.status).toBe(401);
    expect(storagePut).not.toHaveBeenCalled();
    expect(queueSend).not.toHaveBeenCalled();
    await waitOnExecutionContext(ctx);
  });

  it('authenticates and durably stores only imported execution metadata before 200', async () => {
    const { env, getStoredValue, queueSend, storagePut } = makeEnv();
    const { response, ctx } = await postOTLP(env, importedFixture);

    expect(response.status).toBe(200);
    const stored = getStoredValue();
    expect(stored).not.toContain(API_KEY);
    expect(stored).not.toContain('failure body');
    const envelope = JSON.parse(stored);
    expect(envelope.message.importedExecution).toEqual({
      contract: 'cliproxyapi.execution/2',
      orgId: 'org-otlp',
    });
    expect(envelope.message.traces).toHaveLength(5);
    expect(envelope.message.traces[0].SpanAttributes).toMatchObject({
      [TRACE_FLOW.SOURCE]: SOURCE_IMPORTED_EXECUTION,
      [GEN_AI_USAGE.TOTAL_TOKENS]: '23',
      [GEN_AI_USAGE.QUALITY]: 'complete',
    });
    expect(envelope.message.traces[3].SpanAttributes[GEN_AI_USAGE.MISSING]).toBe('true');
    expect(envelope.message.traces[3].SpanAttributes[GEN_AI_USAGE.TOTAL_TOKENS]).toBeUndefined();
    expect(envelope.message.traces[4].StatusCode).toBe('STATUS_CODE_ERROR');
    await waitOnExecutionContext(ctx);
    expect(queueSend).toHaveBeenCalledTimes(1);
    expect(storagePut.mock.invocationCallOrder[0]).toBeLessThan(
      queueSend.mock.invocationCallOrder[0]!,
    );
  });

  it('rejects imported source payloads with unapproved fields before storage', async () => {
    const { env, storagePut, queueSend } = makeEnv();
    const request = structuredClone(importedFixture) as OTLPExportTraceServiceRequest;
    request.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.attributes!.push({
      key: 'http.request.header.authorization',
      value: { stringValue: 'secret-canary' },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { response, ctx } = await postOTLP(env, request);
    expect(response.status).toBe(400);
    expect(storagePut).not.toHaveBeenCalled();
    expect(queueSend).not.toHaveBeenCalled();
    await waitOnExecutionContext(ctx);
    expect(warn.mock.calls.flat().join('\n')).not.toContain('secret-canary');
  });

  it('preserves generic OTLP usage metadata on the existing path', async () => {
    const { env, getStoredValue } = makeEnv();
    const request = otlpBody();
    request.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.attributes!.push(
      { key: GEN_AI_USAGE.INPUT_TOKENS, value: { intValue: '7' } },
      { key: GEN_AI_USAGE.OUTPUT_TOKENS, value: { intValue: '3' } },
    );
    const { response, ctx } = await postOTLP(env, request);
    expect(response.status).toBe(200);
    const envelope = JSON.parse(getStoredValue());
    expect(envelope.message.importedExecution).toBeUndefined();
    expect(envelope.message.traces[0].SpanAttributes[GEN_AI_USAGE.INPUT_TOKENS]).toBe('7');
    expect(envelope.message.traces[0].SpanAttributes[GEN_AI_USAGE.OUTPUT_TOKENS]).toBe('3');
    await waitOnExecutionContext(ctx);
  });
});
