import { waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _clearUsageCache } from '../../usage';
import { _clearAll } from '../../cache';
import { CLI_PROXY, TRACE_FLOW } from '@trace-flow/otel-conventions';
import type { OTLPExportTraceServiceRequest } from '../types';
import importedFixture from '../../../../../fixtures/cliproxyapi-execution-v2.json';
import { makeEnv, otlpBody, postOTLP, postRawOTLP } from './durableFixtures';
import { encodeRequest } from './protobufFixtures';
import nativeProtobufBase64 from '../../../../../fixtures/cliproxyapi-native-a6.otlp.base64?raw';
import liveProtobufBase64 from '../../../../../fixtures/cliproxyapi-native-live.otlp.base64?raw';

const marker = 'X-Trace-Flow-Contract';
const contract = 'cliproxyapi.execution/2';

function protobufImport() {
  return encodeRequest([
    {
      resourceAttributes: [
        {
          key: 'cliproxyapi.installation.id',
          value: { stringValue: '11111111-1111-4111-8111-111111111111' },
        },
        { key: 'service.name', value: { stringValue: 'CLIProxyAPI' } },
      ],
      scopes: [
        {
          name: 'cliproxyapi.execution',
          version: '2',
          spans: [
            {
              traceIdHex: 'aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaa1',
              spanIdHex: '8aaaaaaaaaaaaaa1',
              name: 'gpt-5',
              kind: 2,
              startNano: 1_000_000_000n,
              endNano: 2_000_000_000n,
              status: { code: 1 },
              attributes: [
                {
                  key: 'cliproxyapi.execution.id',
                  value: { stringValue: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1' },
                },
                { key: 'gen_ai.system', value: { stringValue: 'openai' } },
                { key: 'gen_ai.request.model', value: { stringValue: 'gpt-5' } },
                { key: 'cliproxyapi.account.coverage', value: { stringValue: 'unknown' } },
                { key: 'gen_ai.usage.missing', value: { boolValue: true } },
              ],
            },
          ],
        },
      ],
    },
  ]);
}

beforeEach(async () => {
  await _clearAll();
  _clearUsageCache();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
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

describe('imported v2 durable acknowledgement', () => {
  it('accepts Go-exported OTLP protobuf at the Worker endpoint and preserves native metadata', async () => {
    const payload = Uint8Array.from(atob(nativeProtobufBase64.trim()), (char) =>
      char.charCodeAt(0),
    );
    const { env, getStoredValue } = makeEnv();
    const { response, ctx } = await postRawOTLP(env, payload, 'application/x-protobuf');
    expect(response.status).toBe(200);
    expect(response.headers.get(marker)).toBe(contract);
    const envelope = JSON.parse(getStoredValue());
    expect(envelope.message.traces).toHaveLength(1);
    const trace = envelope.message.traces[0];
    expect(trace.TraceId).toBe('aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaa6');
    expect(trace.SpanId).toBe('8aaaaaaaaaaaaaa6');
    expect(trace.ParentSpanId).toBe('');
    expect(trace.Links).toBeUndefined();
    expect(trace.SpanAttributes).toMatchObject({
      [CLI_PROXY.CLIENT_SOURCE]: 'codex',
      [CLI_PROXY.CLIENT_SESSION_ID]: 'child-thread-6',
      [CLI_PROXY.CLIENT_PARENT_SESSION_ID]: 'root-thread-6',
      [CLI_PROXY.CLIENT_ORIGIN_SESSION_ID]: 'origin-session-6',
      [CLI_PROXY.INBOUND_TRACE_ID]: '0123456789abcdef0123456789abcdef',
      [CLI_PROXY.INBOUND_SPAN_ID]: '0123456789abcdef',
      [TRACE_FLOW.IMPORT_SOURCE_HASH]:
        '08d6924e0f8b50ae158a5e2694f5712ede636b60701cad5086feaed2dfbeb50e',
    });
    await waitOnExecutionContext(ctx);
  });
  it('accepts a captured three-span proxy export with Claude and Codex native metadata', async () => {
    const payload = Uint8Array.from(atob(liveProtobufBase64.trim()), (char) => char.charCodeAt(0));
    const { env, getStoredValue } = makeEnv();
    const { response, ctx } = await postRawOTLP(env, payload, 'application/x-protobuf');
    expect(response.status).toBe(200);
    expect(response.headers.get(marker)).toBe(contract);
    const envelope = JSON.parse(getStoredValue());
    expect(envelope.message.traces).toHaveLength(3);
    const traces = envelope.message.traces as { SpanAttributes: Record<string, unknown> }[];
    expect(traces.map((trace) => trace.SpanAttributes[CLI_PROXY.CLIENT_SOURCE])).toContain(
      'claude',
    );
    expect(traces.map((trace) => trace.SpanAttributes[CLI_PROXY.CLIENT_SOURCE])).toContain('codex');
    const codex = traces.find((trace) => trace.SpanAttributes[CLI_PROXY.CLIENT_SOURCE] === 'codex');
    expect(codex?.SpanAttributes).toMatchObject({
      [CLI_PROXY.CLIENT_SESSION_ID]: '22222222-2222-4222-8222-222222222222',
      [CLI_PROXY.CLIENT_PARENT_SESSION_ID]: '11111111-1111-4111-8111-111111111111',
      [CLI_PROXY.INBOUND_TRACE_ID]: '0123456789abcdef0123456789abcdef',
    });
    await waitOnExecutionContext(ctx);
  });

  it.each(['json', 'protobuf'])('waits for R2 before marking %s success', async (encoding) => {
    const { env, storagePut, queueSend } = makeEnv();
    let startWrite!: () => void;
    let finishWrite!: (value: { key: string }) => void;
    const writeStarted = new Promise<void>((resolve) => {
      startWrite = resolve;
    });
    const writeComplete = new Promise<{ key: string }>((resolve) => {
      finishWrite = resolve;
    });
    storagePut.mockImplementationOnce(() => {
      startWrite();
      return writeComplete;
    });
    let settled = false;
    const request = (
      encoding === 'json'
        ? postOTLP(env, importedFixture)
        : postRawOTLP(env, protobufImport(), 'application/x-protobuf')
    ).then((result) => {
      settled = true;
      return result;
    });

    await writeStarted;
    expect(settled).toBe(false);
    expect(queueSend).not.toHaveBeenCalled();
    finishWrite({ key: 'stored' });
    const { response, ctx } = await request;
    expect(response.status).toBe(200);
    expect(response.headers.get(marker)).toBe(contract);
    expect(response.headers.get('X-Trace-Flow-Recording')).toBe('true');
    expect(response.headers.get('Content-Type')).toContain('application/json');
    expect(await response.json()).toEqual({ partialSuccess: {} });
    const envelope = JSON.parse(storagePut.mock.calls[0]![1] as string);
    expect(envelope.message.importedExecution.contract).toBe(contract);
    await waitOnExecutionContext(ctx);
  });

  it('returns marked acknowledgements for separately persisted exact replays', async () => {
    const { env, getStoredValue, storagePut } = makeEnv();
    const traces = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { response, ctx } = await postOTLP(env, importedFixture);
      expect(response.status).toBe(200);
      expect(response.headers.get(marker)).toBe(contract);
      expect(response.headers.get('X-Trace-Flow-Recording')).toBe('true');
      expect(await response.json()).toEqual({ partialSuccess: {} });
      traces.push(JSON.parse(getStoredValue()).message.traces);
      await waitOnExecutionContext(ctx);
    }
    expect(storagePut).toHaveBeenCalledTimes(2);
    expect(
      traces[1].map((trace: { SpanAttributes: Record<string, string> }) => [
        trace.SpanAttributes[TRACE_FLOW.IMPORT_IDENTITY],
        trace.SpanAttributes[TRACE_FLOW.IMPORT_SOURCE_HASH],
      ]),
    ).toEqual(
      traces[0].map((trace: { SpanAttributes: Record<string, string> }) => [
        trace.SpanAttributes[TRACE_FLOW.IMPORT_IDENTITY],
        trace.SpanAttributes[TRACE_FLOW.IMPORT_SOURCE_HASH],
      ]),
    );
  });

  it('omits the marker when imported persistence fails', async () => {
    const { env, queueSend } = makeEnv({ storageError: new Error('R2 unavailable') });
    const { response, ctx } = await postOTLP(env, importedFixture);
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('1');
    expect(response.headers.get(marker)).toBeNull();
    expect(response.headers.get('X-Trace-Flow-Recording')).toBeNull();
    expect(queueSend).not.toHaveBeenCalled();
    await waitOnExecutionContext(ctx);
  });

  it('still marks durable acceptance when queue publication fails', async () => {
    const { env, queueSend, storagePut } = makeEnv();
    queueSend.mockRejectedValueOnce(new Error('queue unavailable'));
    const { response, ctx } = await postOTLP(env, importedFixture);
    expect(response.status).toBe(200);
    expect(response.headers.get(marker)).toBe(contract);
    expect(storagePut).toHaveBeenCalledOnce();
    await waitOnExecutionContext(ctx);
  });

  it.each(['suspended', 'canceled'])(
    'fully rejects %s recording without a marker',
    async (status) => {
      const { env, storagePut, queueSend } = makeEnv({ subscriptionStatus: status });
      const { response, ctx } = await postOTLP(env, importedFixture);
      expect(response.status).toBe(200);
      expect(response.headers.get('X-Trace-Flow-Recording')).toBe('false');
      expect(response.headers.get(marker)).toBeNull();
      expect(await response.json()).toMatchObject({
        partialSuccess: { rejectedSpans: 6, errorMessage: expect.any(String) },
      });
      expect(storagePut).not.toHaveBeenCalled();
      expect(queueSend).not.toHaveBeenCalled();
      await waitOnExecutionContext(ctx);
    },
  );

  it.each(['unsupported', 'mixed', 'invalid'])(
    'rejects %s imports without copying a supplied marker',
    async (kind) => {
      const { env, storagePut } = makeEnv();
      const body = structuredClone(importedFixture) as OTLPExportTraceServiceRequest;
      const scopes = body.resourceSpans[0]!.scopeSpans;
      if (kind === 'unsupported') scopes[0]!.scope!.version = '3';
      if (kind === 'mixed') scopes.push(otlpBody().resourceSpans[0]!.scopeSpans[0]!);
      if (kind === 'invalid')
        scopes[0]!.spans[4]!.attributes!.push({
          key: 'private.payload',
          value: { stringValue: 'secret-canary' },
        });
      const { response, ctx } = await postRawOTLP(
        env,
        JSON.stringify(body),
        'application/json',
        undefined,
        { [marker]: contract },
      );
      expect(response.status).toBe(400);
      expect(response.headers.get(marker)).toBeNull();
      expect(JSON.stringify(await response.json())).not.toContain('secret-canary');
      expect(storagePut).not.toHaveBeenCalled();
      await waitOnExecutionContext(ctx);
    },
  );

  it.each(['ORG_LIMITER', 'IP_LIMITER'] as const)(
    'omits the marker for %s denial',
    async (limiter) => {
      const { env, storagePut } = makeEnv();
      vi.spyOn(env[limiter], 'limit').mockResolvedValue({ success: false });
      const { response, ctx } = await postOTLP(env, importedFixture);
      expect(response.status).toBe(429);
      expect(response.headers.get(marker)).toBeNull();
      expect(storagePut).not.toHaveBeenCalled();
      await waitOnExecutionContext(ctx);
    },
  );

  it.each(['generic', 'empty', 'malformed', 'unauthorized'])(
    'never copies the marker for %s requests',
    async (kind) => {
      const { env } = makeEnv();
      const body =
        kind === 'empty'
          ? { resourceSpans: [] }
          : kind === 'generic'
            ? otlpBody()
            : importedFixture;
      const { response, ctx } = await postRawOTLP(
        env,
        kind === 'malformed' ? '{' : JSON.stringify(body),
        'application/json',
        undefined,
        {
          [marker]: contract,
          ...(kind === 'unauthorized' ? { 'X-Trace-Flow-Api-Key': '' } : {}),
        },
      );
      expect(response.status).toBe(
        kind === 'malformed' ? 400 : kind === 'unauthorized' ? 401 : 200,
      );
      expect(response.headers.get(marker)).toBeNull();
      await waitOnExecutionContext(ctx);
    },
  );
});
