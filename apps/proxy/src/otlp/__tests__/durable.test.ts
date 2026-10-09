import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { analyticsKeyId } from '@trace-flow/utils';
import { app } from '../../index';
import { _clearAll } from '../../cache';
import { _clearUsageCache } from '../../usage';
import type { OTLPExportTraceServiceRequest } from '../types';
import { GEN_AI_USAGE, SOURCE_IMPORTED_EXECUTION, TRACE_FLOW } from '@trace-flow/otel-conventions';
import importedFixture from '../../../../../fixtures/cliproxyapi-execution-v2.json';

import {
  API_KEY,
  makeEnv,
  otlpBody,
  postOTLP,
  postRawOTLP,
  compactSpanFlood,
} from './durableFixtures';

describe('OTLP durable acceptance', () => {
  beforeEach(async () => {
    await _clearAll();
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
    expect(response.headers.get('X-Trace-Flow-Contract')).toBeNull();
    expect(response.headers.get('Retry-After')).toBe('1');
    expect(queueSend).not.toHaveBeenCalled();
    await waitOnExecutionContext(ctx);
  });

  it('returns retryable 503 and discards its envelope for an internal recording decision error', async () => {
    const { env, storagePut, storageDelete, queueSend } = makeEnv({
      usageError: new Error('usage tracker unavailable'),
    });
    const { response, ctx } = await postOTLP(env, otlpBody());

    expect(response.status).toBe(503);
    expect(response.headers.get('X-Trace-Flow-Contract')).toBeNull();
    expect(response.headers.get('Retry-After')).toBe('1');
    await waitOnExecutionContext(ctx);
    expect(storagePut).toHaveBeenCalledTimes(1);
    expect(storageDelete).toHaveBeenCalledWith(storagePut.mock.calls[0]![0]);
    expect(queueSend).not.toHaveBeenCalled();
  });

  it('sheds rate-limited IPs before authorizing the key', async () => {
    const { env, storagePut } = makeEnv();
    vi.mocked(env.IP_LIMITER.limit).mockResolvedValue({ success: false });
    const { response, ctx } = await postOTLP(env, otlpBody());

    expect(response.status).toBe(429);
    expect(fetch).not.toHaveBeenCalled();
    expect(storagePut).not.toHaveBeenCalled();
    await waitOnExecutionContext(ctx);
  });

  it('writes the envelope while the usage check is still in flight', async () => {
    let allowUsage!: () => void;
    const { env, storagePut, queueSend, getStoredValue } = makeEnv({
      usageResponse: () =>
        new Promise((resolve) => {
          allowUsage = () => resolve(Response.json({ allowed: true }));
        }),
    });
    const pending = postOTLP(env, otlpBody());

    await vi.waitFor(() => expect(storagePut).toHaveBeenCalledTimes(1));
    expect(queueSend).not.toHaveBeenCalled();
    allowUsage();
    const { response, ctx } = await pending;

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Trace-Flow-Recording')).toBe('true');
    expect(JSON.parse(getStoredValue()).message.traces[0].TierAtIngestion).toBe('pro');
    await waitOnExecutionContext(ctx);
    expect(queueSend).toHaveBeenCalledTimes(1);
  });

  it('discards the envelope of an export over its limit, then stops writing for that org', async () => {
    const periodEnd = Date.now() + 60_000;
    const { env, storagePut, storageDelete, queueSend, usageFetch } = makeEnv({
      usageResponse: async () => Response.json({ allowed: false, periodEnd }),
    });

    const first = await postOTLP(env, otlpBody());
    expect(first.response.status).toBe(200);
    expect(await first.response.json()).toMatchObject({ partialSuccess: { rejectedSpans: 1 } });
    await waitOnExecutionContext(first.ctx);
    expect(storagePut).toHaveBeenCalledTimes(1);
    expect(storageDelete).toHaveBeenCalledWith(storagePut.mock.calls[0]![0]);

    const second = await postOTLP(env, otlpBody());
    expect(await second.response.json()).toMatchObject({ partialSuccess: { rejectedSpans: 1 } });
    await waitOnExecutionContext(second.ctx);
    expect(usageFetch).toHaveBeenCalledTimes(1);
    expect(storagePut).toHaveBeenCalledTimes(1);
    expect(queueSend).not.toHaveBeenCalled();
  });

  it('reports a rejected export whose envelope it cannot discard', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { env, storageDelete } = makeEnv({
      usageResponse: async () => Response.json({ allowed: false, periodEnd: Date.now() + 60_000 }),
      deleteError: new Error('R2 unavailable'),
    });
    const { response, ctx } = await postOTLP(env, otlpBody());

    expect(response.status).toBe(200);
    await waitOnExecutionContext(ctx);
    expect(storageDelete).toHaveBeenCalledTimes(1);
    expect(error.mock.calls.flat().join('\n')).toContain(
      'otlp.provisional_delivery_discard_failed',
    );
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
    expect(response.headers.get('X-Trace-Flow-Contract')).toBeNull();
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
    expect(response.headers.get('X-Trace-Flow-Contract')).toBeNull();
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
    expect(envelope.message.traces).toHaveLength(6);
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
    expect(response.headers.get('X-Trace-Flow-Contract')).toBeNull();
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
    expect(response.headers.get('X-Trace-Flow-Contract')).toBeNull();
    const envelope = JSON.parse(getStoredValue());
    expect(envelope.message.importedExecution).toBeUndefined();
    expect(envelope.message.traces[0].SpanAttributes[GEN_AI_USAGE.INPUT_TOKENS]).toBe('7');
    expect(envelope.message.traces[0].SpanAttributes[GEN_AI_USAGE.OUTPUT_TOKENS]).toBe('3');
    await waitOnExecutionContext(ctx);
  });
});
