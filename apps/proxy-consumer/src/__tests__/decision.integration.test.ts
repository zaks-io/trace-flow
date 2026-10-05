import {
  createExecutionContext,
  env,
  runInDurableObject,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueueMessage, TinybirdTrace, TraceDeliveryEnvelope } from '@trace-flow/types';
import { GEN_AI, GEN_AI_COST, GEN_AI_USAGE } from '@trace-flow/otel-conventions';
import { serializeModelPricing, TYPESAFE_JEV_PRICING } from '@trace-flow/pricing';
import { buildTraceDeliveryKey, encryptStoredBodyPayload } from '@trace-flow/utils';
import worker from '../index';
import { calculateShardId } from '../sharding';

const rootKeyBase64 = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
const catalogRequests: URL[] = [];

function decision(provider: 'typesafe' | 'openrouter', resolvedModel: string): QueueMessage {
  const requestId = crypto.randomUUID();
  return {
    requestId,
    traceId: requestId.replaceAll('-', ''),
    apiKey: `decision-key-${requestId}`,
    orgId: `decision-org-${requestId}`,
    operationName: 'decision',
    targetUrl:
      provider === 'typesafe'
        ? 'https://api.typesafe.ai/v1/systemone'
        : 'https://openrouter.ai/api/alpha/decisions',
    request: {
      id: requestId,
      provider,
      model: provider === 'typesafe' ? 'jev-latest' : '~typesafe/jev-latest',
      messages: [],
      timestamp: 1000,
    },
    response: { id: requestId, provider, status: 200, timestamp: 1500, latency: 500 },
    responseMetadata: { model: resolvedModel, id: 'upstream-decision-id' },
    tokens: {
      promptTokens: 1000,
      uncachedInputTokens: 1000,
      completionTokens: 9,
      totalTokens: 1009,
    },
    timing: {
      requestStart: 1000,
      requestSent: 1100,
      responseReceived: 1200,
      responseComplete: 1500,
    },
    receivedAt: Date.now() * 1_000_000,
  };
}

async function deliver(payload: QueueMessage) {
  const key = buildTraceDeliveryKey(`decision-${payload.requestId}`);
  const bodyKey = `bodies/${payload.requestId}`;
  const encryptedPayload = await encryptStoredBodyPayload(
    JSON.stringify({
      requestBody: JSON.stringify({
        model: payload.request.model,
        state: 'private-consumer-state',
        questions: {
          choice: { type: 'choice', options: ['private-consumer-option', 'wait'] },
          score: { type: 'score' },
          noul: { type: 'noul' },
        },
      }),
      responseBody: JSON.stringify({
        model: payload.responseMetadata!.model,
        answers: { choice: { choice: 'private-consumer-option' }, score: 0.5, noul: 0.7 },
      }),
    }),
    { rootKeyBase64, keyId: 'test', orgId: payload.orgId!, objectKey: bodyKey },
  );
  const envelope: TraceDeliveryEnvelope = {
    version: 1,
    message: payload,
    body: { key: bodyKey, orgId: payload.orgId!, encryptedPayload },
  };
  await env.STORAGE.put(key, JSON.stringify(envelope));
  const shard = calculateShardId(payload.apiKey, env.NUM_SHARDS ?? 10);
  const batcher = env.TRACE_BATCHER.get(env.TRACE_BATCHER.idFromName(`batcher-${shard}`));
  async function stagedRows() {
    return runInDurableObject(batcher, async (_instance, state) => {
      const rows = [...state.storage.sql.exec<{ data: string }>('SELECT data FROM traces')];
      await state.storage.deleteAlarm();
      return rows
        .flatMap(({ data }) => JSON.parse(data) as TinybirdTrace[])
        .filter((row) => row.TraceId === payload.traceId);
    });
  }
  let atAck:
    | Promise<{ body: R2ObjectBody | null; envelope: R2ObjectBody | null; rows: TinybirdTrace[] }>
    | undefined;
  const ack = vi.fn(() => {
    atAck = Promise.all([env.STORAGE.get(bodyKey), env.STORAGE.get(key), stagedRows()]).then(
      ([body, envelope, rows]) => ({ body, envelope, rows }),
    );
  });
  const retry = vi.fn();
  const ctx = createExecutionContext();
  await worker.queue(
    {
      queue: 'trace-flow-requests-dev',
      messages: [
        {
          id: `queue-${payload.requestId}`,
          timestamp: new Date(),
          body: { type: 'delivery', key },
          attempts: 0,
          ack,
          retry,
        },
      ],
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    },
    env,
    ctx,
  );
  expect(retry).not.toHaveBeenCalled();
  expect(ack).toHaveBeenCalledOnce();
  const snapshot = await atAck!;
  expect(snapshot.envelope).toBeNull();
  expect(snapshot.body?.customMetadata).toEqual({ orgId: payload.orgId });
  expect(await snapshot.body?.json()).toEqual(encryptedPayload);
  expect(snapshot.rows).toHaveLength(2);
  expect(JSON.stringify(snapshot.rows)).not.toContain('private-consumer');
  const roots = snapshot.rows.filter((row) => row.SpanAttributes[GEN_AI.OPERATION_NAME]);
  expect(roots).toHaveLength(1);
  const root = roots[0]!;
  const output = snapshot.rows.find((row) => row.ParentSpanId === root.SpanId)!;
  expect(output.SpanAttributes[GEN_AI.CONTENT_TYPE]).toBe('decision');
  expect(output.SpanAttributes[GEN_AI_USAGE.INPUT_TOKENS]).toBeUndefined();
  expect(output.SpanAttributes[GEN_AI_COST.TOTAL]).toBeUndefined();
  expect(root.SpanAttributes).toMatchObject({
    [GEN_AI.SYSTEM]: payload.request.provider,
    [GEN_AI.OPERATION_NAME]: 'decision',
    [GEN_AI.REQUEST_MODEL]: payload.request.model,
    [GEN_AI.RESPONSE_MODEL]: payload.responseMetadata!.model,
    [GEN_AI_USAGE.INPUT_TOKENS]: '1000',
    [GEN_AI_USAGE.OUTPUT_TOKENS]: '9',
  });
  expect(root.SpanAttributes[GEN_AI.FINISH_REASON]).toBeUndefined();
  expect(root.SpanAttributes[GEN_AI.SERVER_TTFT]).toBeUndefined();
  expect(root.SpanAttributes[GEN_AI.TOKENS_PER_SECOND]).toBeUndefined();
  expect(root['Events.Name']).toContain('output.decision');
  await waitOnExecutionContext(ctx);
  return root;
}

describe('Jev accounting through the consumer queue and durable staging', () => {
  beforeEach(() => {
    catalogRequests.length = 0;
    if (!env.TINYBIRD_HOST) throw new Error('Missing Tinybird test host');
    const tinybirdOrigin = new URL(env.TINYBIRD_HOST).origin;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (
        request.method === 'GET' &&
        url.origin === 'https://openrouter.ai' &&
        url.pathname === '/api/v1/models'
      ) {
        catalogRequests.push(url);
        expect(url.searchParams.get('output_modalities')).toBe('text,decisions');
        return Response.json({
          data: [
            {
              id: 'typesafe/jev-1.13',
              canonical_slug: 'typesafe/jev-1.13-20260917',
              pricing: { prompt: '0.000000042', completion: '0' },
            },
            {
              id: '~typesafe/jev-latest',
              alias_target: { slug: 'typesafe/jev-1.13' },
              pricing: { prompt: '0.000099', completion: '0.000099' },
            },
            {
              id: 'typesafe/jev-9.99.0',
              pricing: { prompt: '0.000099', completion: '0.000099' },
            },
          ],
        });
      }
      if (
        request.method === 'POST' &&
        url.origin === tinybirdOrigin &&
        url.pathname === '/v0/events'
      ) {
        await request.text();
        return Response.json({ successful_rows: 2, quarantined_rows: 0 });
      }
      throw new Error(`Unexpected transport: ${request.method} ${request.url}`);
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('uses direct TypeSafe versioned default rates on a KV miss', async () => {
    const payload = decision('typesafe', TYPESAFE_JEV_PRICING.model);
    const root = await deliver(payload);
    expect(root.SpanAttributes).toMatchObject({
      [GEN_AI_COST.INPUT]: '0.000042',
      [GEN_AI_COST.OUTPUT]: '0',
      [GEN_AI_COST.TOTAL]: '0.000042',
    });
    expect(root.SpanAttributes[GEN_AI_COST.UPSTREAM]).toBeUndefined();
    expect(catalogRequests).toHaveLength(0);
  });

  it('leaves an unknown direct TypeSafe version unpriced despite a gateway catalog match', async () => {
    const root = await deliver(decision('typesafe', 'jev-9.99.0'));
    expect(root.SpanAttributes[GEN_AI_COST.TOTAL]).toBeUndefined();
    expect(root.SpanAttributes[GEN_AI_COST.INPUT]).toBeUndefined();
    expect(root.SpanAttributes[GEN_AI_COST.UPSTREAM]).toBeUndefined();
    expect(catalogRequests).toHaveLength(0);
    expect(await env.MODEL_PRICING.get('pricing:typesafe:jev-9.99.0')).toBeNull();
  });

  it.each([0.000019992, 0])(
    'prices an OpenRouter alias by the resolved canonical model and retains reported cost %s',
    async (upstreamCost) => {
      const payload = decision('openrouter', 'typesafe/jev-1.13-20260917');
      payload.tokens!.upstreamCost = upstreamCost;
      await env.MODEL_PRICING.put(
        `pricing:openrouter:${payload.request.model}`,
        serializeModelPricing({
          promptCostPerMillion: 99_000_000,
          completionCostPerMillion: 99_000_000,
          source: 'manual',
          updatedAt: 1,
        }),
      );
      const root = await deliver(payload);
      expect(root.SpanAttributes).toMatchObject({
        [GEN_AI_COST.INPUT]: '0.000042',
        [GEN_AI_COST.OUTPUT]: '0',
        [GEN_AI_COST.TOTAL]: '0.000042',
        [GEN_AI_COST.UPSTREAM]: String(upstreamCost),
      });
      const cached = await env.MODEL_PRICING.get(
        'pricing:openrouter:typesafe/jev-1.13-20260917',
        'json',
      );
      expect(cached).toMatchObject({
        promptCostPerMillion: 42_000,
        completionCostPerMillion: 0,
        source: 'openrouter',
      });
    },
  );
});
