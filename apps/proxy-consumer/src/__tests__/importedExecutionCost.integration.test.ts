import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createExecutionContext, env, runInDurableObject } from 'cloudflare:test';
import type * as SentryCloudflare from '@sentry/cloudflare';
import type { QueueMessageUnion, TinybirdTrace, TraceDeliveryEnvelope } from '@trace-flow/types';
import {
  CLI_PROXY,
  GEN_AI,
  GEN_AI_COST,
  GEN_AI_USAGE,
  IMPORTED_EXECUTION,
  TRACE_FLOW,
} from '@trace-flow/otel-conventions';
import { serializeModelPricing, type ModelPricing } from '@trace-flow/pricing';
import { buildTraceDeliveryKey } from '@trace-flow/utils';
import worker from '../index';
import { calculateShardId } from '../sharding';
import { importedPricingTrace } from './importedPricingFixtures';
import { priceImportedTraces } from '../importedExecutionCost';
import publishedPricing from '../../../../fixtures/imported-execution-pricing.json';

vi.mock('../tinybird', () => ({
  insertIntoTinybird: vi.fn().mockResolvedValue(undefined),
  insertIntoTinybirdWithRetry: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@sentry/cloudflare', async (original) => ({
  ...(await original<typeof SentryCloudflare>()),
  captureMessage: vi.fn(),
  instrumentDurableObjectWithSentry: <T>(_options: unknown, cls: T): T => cls,
}));

const pricing: ModelPricing = {
  promptCostPerMillion: 3_000_000,
  completionCostPerMillion: 15_000_000,
  cacheReadCostPerMillion: 300_000,
  cacheWriteCostPerMillion: 3_750_000,
  source: 'manual',
  updatedAt: 123,
};
const tokens = { input: 1000, read: 200, write: 100, output: 300, reasoning: 50 };
const org = 'org-imported-pricing';

async function deliver(trace: TinybirdTrace, delivery: string) {
  const key = buildTraceDeliveryKey(delivery);
  const envelope: TraceDeliveryEnvelope = {
    version: 1,
    message: {
      type: 'otlp',
      apiKey: 'test-import-key',
      traces: [trace],
      receivedAt: trace.ReceivedAt,
      importedExecution: { contract: IMPORTED_EXECUTION.CONTRACT, orgId: org },
    },
  };
  await env.STORAGE.put(key, JSON.stringify(envelope));
  const ack = vi.fn();
  const retry = vi.fn();
  const batch = {
    queue: 'trace-flow-requests-dev',
    messages: [
      {
        id: delivery,
        body: { type: 'delivery', key },
        timestamp: new Date(),
        attempts: 0,
        ack,
        retry,
      },
    ],
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<QueueMessageUnion>;
  await worker.queue(batch, env, createExecutionContext());
  expect(retry).not.toHaveBeenCalled();
  expect(ack).toHaveBeenCalledOnce();
  expect(await env.STORAGE.get(key)).toBeNull();
  const shard = calculateShardId(`org:${org}`, env.NUM_SHARDS ?? 10);
  return runInDurableObject(
    env.TRACE_BATCHER.get(env.TRACE_BATCHER.idFromName(`batcher-${shard}`)),
    (_instance, state) => {
      const rows = [...state.storage.sql.exec<{ data: string }>('SELECT data FROM traces')];
      return {
        rows: rows
          .flatMap(({ data }) => JSON.parse(data) as TinybirdTrace[])
          .filter(
            (stored) =>
              stored.SpanAttributes[TRACE_FLOW.IMPORT_IDENTITY] ===
              trace.SpanAttributes[TRACE_FLOW.IMPORT_IDENTITY],
          ),
        repairs: [...state.storage.sql.exec('SELECT id FROM trace_repairs')].length,
      };
    },
  );
}

beforeEach(() => vi.clearAllMocks());

describe('imported pricing through durable consumer staging', () => {
  it.each([
    ['openai', 'openai', 'gpt-5', '1'],
    ['anthropic', 'anthropic', 'claude', '2'],
    ['google', 'google', 'gemini', '3'],
    ['codex', 'openai', 'gpt-6.1-sol', 'e'],
    ['claude', 'anthropic', 'claude-opus-5-5', 'f'],
  ])(
    'prices %s known buckets once and stores USD provenance',
    async (provider, catalogProvider, model, identity) => {
      await env.MODEL_PRICING.put(
        `pricing:${catalogProvider}:${model}`,
        serializeModelPricing(pricing),
      );
      const trace = importedPricingTrace(identity, provider, model, tokens);
      const stored = await deliver(trace, `price-${provider}`);
      expect(stored.rows).toHaveLength(1);
      expect(stored.rows[0]!.SpanAttributes).toMatchObject({
        ...trace.SpanAttributes,
        [GEN_AI_COST.INPUT]: '0.003',
        [GEN_AI_COST.OUTPUT]: '0.0045',
        [GEN_AI_COST.CACHE_READ]: '0.00006',
        [GEN_AI_COST.CACHE_CREATION]: '0.000375',
        [GEN_AI_COST.REASONING]: '0.00075',
        [GEN_AI_COST.TOTAL]: '0.008685',
        [TRACE_FLOW.COST_STATUS]: 'priced',
        [TRACE_FLOW.COST_PRICED_TOKENS]: '1650',
        [TRACE_FLOW.COST_CATALOG_VERSION]: 'manual@123',
        [TRACE_FLOW.COST_UNIT]: 'USD',
        [TRACE_FLOW.COST_CATALOG_KEY]: `pricing:${catalogProvider}:${model}`,
      });
    },
  );

  it('keeps first accepted prices after separate delivery, catalog change, and durable restart', async () => {
    await env.MODEL_PRICING.put('pricing:openai:replay-model', serializeModelPricing(pricing));
    const trace = importedPricingTrace('4', 'codex', 'replay-model', tokens);
    const initial = await deliver(trace, 'price-first');
    expect(initial.rows[0]!.SpanAttributes[GEN_AI_COST.TOTAL]).toBe('0.008685');
    await env.MODEL_PRICING.put(
      'pricing:openai:replay-model',
      serializeModelPricing({ ...pricing, promptCostPerMillion: 100_000_000, updatedAt: 999 }),
    );
    const shard = calculateShardId(`org:${org}`, 10);
    await expect(
      runInDurableObject(
        env.TRACE_BATCHER.get(env.TRACE_BATCHER.idFromName(`batcher-${shard}`)),
        (_instance, state) => state.abort(),
      ),
    ).rejects.toThrow();
    const replay = await deliver(
      { ...trace, ReceivedAt: trace.ReceivedAt + 1_000_000_000 },
      'price-new-post',
    );
    expect(replay.rows).toEqual(initial.rows);
    expect(replay.repairs).toBe(0);
  });

  it.each(['flex', 'priority', 'batch'] as const)(
    'uses published %s rates and context boundaries in the consumer',
    async (tier) => {
      await env.MODEL_PRICING.put(
        'pricing:openai:gpt-6.1-sol',
        serializeModelPricing(publishedPricing.pricing as ModelPricing),
      );
      const trace = importedPricingTrace(
        { flex: '5', priority: '6', batch: '7' }[tier],
        'openai',
        publishedPricing.model,
        tokens,
      );
      trace.SpanAttributes[CLI_PROXY.RESPONSE_SERVICE_TIER] = tier;
      const { rows } = await deliver(trace, `price-tier-${tier}`);
      expect(rows[0]!.SpanAttributes).toMatchObject({
        [GEN_AI_COST.TOTAL]: tier === 'priority' ? '0.01154' : '0.002885',
        [TRACE_FLOW.COST_STATUS]: 'priced',
      });
      expect(JSON.parse(rows[0]!.SpanAttributes[TRACE_FLOW.COST_RATES]!)).toMatchObject({
        serviceTier: tier,
        referenceUrl: publishedPricing.referenceUrl,
      });
      const below = importedPricingTrace('b', 'openai', publishedPricing.model, {
        ...tokens,
        input: 271699,
      });
      below.SpanAttributes[CLI_PROXY.RESPONSE_SERVICE_TIER] = tier;
      const at = importedPricingTrace('c', 'openai', publishedPricing.model, {
        ...tokens,
        input: 271700,
      });
      at.SpanAttributes[CLI_PROXY.RESPONSE_SERVICE_TIER] = tier;
      const [pricedBelow, pricedAt] = await priceImportedTraces([below, at], env.MODEL_PRICING);
      expect(pricedBelow!.SpanAttributes[GEN_AI_COST.TOTAL]).toBe(
        tier === 'priority' ? '1.094336' : '0.273584',
      );
      expect(pricedAt!.SpanAttributes[GEN_AI_COST.TOTAL]).toBe(
        tier === 'priority' ? '2.18518' : '0.546295',
      );
    },
  );

  it('preserves explicit free cache rates through the consumer', async () => {
    await env.MODEL_PRICING.put(
      'pricing:openai:free-cache',
      serializeModelPricing({
        ...pricing,
        cacheReadCostPerMillion: 0,
        cacheWriteCostPerMillion: 0,
      }),
    );
    const trace = importedPricingTrace('d', 'openai', 'free-cache', tokens);
    const [priced] = await priceImportedTraces([trace], env.MODEL_PRICING);
    expect(priced!.SpanAttributes).toMatchObject({
      [GEN_AI_COST.CACHE_READ]: '0',
      [GEN_AI_COST.CACHE_CREATION]: '0',
      [TRACE_FLOW.COST_STATUS]: 'priced',
    });
  });

  it('keeps unknown models and missing actual models unpriced', async () => {
    const trace = importedPricingTrace('8', 'openai', 'unknown-model', tokens);
    let [priced] = await priceImportedTraces([trace], env.MODEL_PRICING);
    expect(priced!.SpanAttributes).toMatchObject({
      [TRACE_FLOW.COST_STATUS]: 'unpriced',
      [TRACE_FLOW.COST_REASONS]: 'model_not_in_catalog',
    });
    expect(priced!.SpanAttributes[GEN_AI_COST.TOTAL]).toBeUndefined();
    delete trace.SpanAttributes[GEN_AI.RESPONSE_MODEL];
    [priced] = await priceImportedTraces([trace], env.MODEL_PRICING);
    expect(priced!.SpanAttributes[TRACE_FLOW.COST_REASONS]).toBe('model_unreported');
    expect(priced!.SpanAttributes[GEN_AI.REQUEST_MODEL]).toBe('requested-alias');
  });

  it('shows excluded cache rates and unclassified token coverage', async () => {
    await env.MODEL_PRICING.put(
      'pricing:openai:partial-model',
      serializeModelPricing({
        promptCostPerMillion: 3_000_000,
        completionCostPerMillion: 15_000_000,
        updatedAt: 1,
        source: 'manual',
      }),
    );
    const trace = importedPricingTrace('9', 'openai', 'partial-model', {
      ...tokens,
      unclassified: 50,
    });
    const { rows } = await deliver(trace, 'price-partial');
    expect(rows[0]!.SpanAttributes).toMatchObject({
      [GEN_AI_COST.TOTAL]: '0.00825',
      [TRACE_FLOW.COST_STATUS]: 'partial',
      [TRACE_FLOW.COST_PRICED_TOKENS]: '1350',
    });
    expect(rows[0]!.SpanAttributes[GEN_AI_COST.CACHE_READ]).toBeUndefined();
    expect(rows[0]!.SpanAttributes[GEN_AI_COST.CACHE_IMPACT]).toBeUndefined();
  });

  it('rejects client costs and malformed token buckets', async () => {
    const trace = importedPricingTrace('a', 'openai', 'unknown', tokens);
    trace.SpanAttributes[GEN_AI_COST.TOTAL] = '123';
    await expect(priceImportedTraces([trace], env.MODEL_PRICING)).rejects.toThrow(
      'client-supplied costs',
    );
    delete trace.SpanAttributes[GEN_AI_COST.TOTAL];
    delete trace.SpanAttributes[GEN_AI_USAGE.INPUT_TOKENS_UNCACHED];
    await expect(priceImportedTraces([trace], env.MODEL_PRICING)).rejects.toThrow('bucket');
  });
});
