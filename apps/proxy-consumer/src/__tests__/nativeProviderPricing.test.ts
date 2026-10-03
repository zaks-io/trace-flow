import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { CLI_PROXY, GEN_AI_COST, GEN_AI_USAGE, TRACE_FLOW } from '@trace-flow/otel-conventions';
import { serializeModelPricing, type ModelPricing } from '@trace-flow/pricing';
import { priceImportedTraces } from '../importedExecutionCost';
import { importedPricingTrace } from './importedPricingFixtures';

const pricing: ModelPricing = {
  promptCostPerMillion: 3_000_000,
  completionCostPerMillion: 15_000_000,
  cacheReadCostPerMillion: 300_000,
  source: 'models.dev',
  updatedAt: 123,
};
const tokens = { input: 1000, read: 200, write: 0, output: 300, reasoning: 50 };

async function price(provider: string, model: string) {
  const [trace] = await priceImportedTraces(
    [importedPricingTrace('a', provider, model, tokens)],
    env.MODEL_PRICING,
  );
  return trace!.SpanAttributes;
}

describe('native imported provider catalog lookup', () => {
  it.each([
    ['codex', 'openai'],
    ['claude', 'anthropic'],
  ])('preserves %s overrides ahead of canonical %s pricing', async (provider, canonical) => {
    const model = `override-${provider}`;
    await env.MODEL_PRICING.put(
      `pricing:${canonical}:${model}-20261003`,
      serializeModelPricing(pricing),
    );
    await env.MODEL_PRICING.put(
      `pricing:${provider}:${model}`,
      serializeModelPricing({ ...pricing, promptCostPerMillion: 6_000_000, source: 'manual' }),
    );
    expect(await price(provider, `${model}-20261003`)).toMatchObject({
      [TRACE_FLOW.COST_CATALOG_KEY]: `pricing:${provider}:${model}`,
      [TRACE_FLOW.COST_CATALOG_VERSION]: 'manual@123',
      [GEN_AI_COST.TOTAL]: '0.01131',
    });
    await env.MODEL_PRICING.put(
      `pricing:${provider}:${model}-20261003`,
      serializeModelPricing(pricing),
    );
    expect(await price(provider, `${model}-20261003`)).toMatchObject({
      [TRACE_FLOW.COST_CATALOG_KEY]: `pricing:${provider}:${model}-20261003`,
      [GEN_AI_COST.TOTAL]: '0.00831',
    });
  });

  it('resolves dated native models through a canonical family key', async () => {
    await env.MODEL_PRICING.put('pricing:anthropic:dated-model', serializeModelPricing(pricing));
    expect(await price('claude', 'dated-model-20261003')).toMatchObject({
      [TRACE_FLOW.COST_CATALOG_KEY]: 'pricing:anthropic:dated-model',
      [TRACE_FLOW.COST_CATALOG_VERSION]: 'models.dev@123',
      [GEN_AI_COST.TOTAL]: '0.00831',
    });
  });

  it('rejects malformed native overrides instead of using canonical rates', async () => {
    await env.MODEL_PRICING.put('pricing:openai:invalid-override', serializeModelPricing(pricing));
    await env.MODEL_PRICING.put(
      'pricing:codex:invalid-override',
      JSON.stringify({ ...pricing, promptCostPerMillion: -1 }),
    );
    await expect(price('codex', 'invalid-override')).rejects.toThrow('finite and nonnegative');
  });

  it.each(['openai-compatible', 'claude-bedrock', 'Codex', 'claude ', 'openrouter'])(
    'does not give %s first-party fallback rates',
    async (provider) => {
      await env.MODEL_PRICING.put(
        'pricing:openai:compatible-model',
        serializeModelPricing(pricing),
      );
      await env.MODEL_PRICING.put(
        'pricing:anthropic:compatible-model',
        serializeModelPricing(pricing),
      );
      const attributes = await price(provider, 'compatible-model');
      expect(attributes).toMatchObject({
        [TRACE_FLOW.COST_STATUS]: 'unpriced',
        [TRACE_FLOW.COST_REASONS]: 'model_not_in_catalog',
      });
      expect(attributes[GEN_AI_COST.TOTAL]).toBeUndefined();
      expect(attributes[TRACE_FLOW.COST_CATALOG_KEY]).toBeUndefined();
    },
  );

  it('keeps missing usage and unsupported tiers unpriced after a catalog fallback', async () => {
    await env.MODEL_PRICING.put('pricing:openai:uncovered-model', serializeModelPricing(pricing));
    const trace = importedPricingTrace('a', 'codex', 'uncovered-model', tokens);
    trace.SpanAttributes[CLI_PROXY.RESPONSE_SERVICE_TIER] = 'priority';
    let [priced] = await priceImportedTraces([trace], env.MODEL_PRICING);
    expect(priced!.SpanAttributes[TRACE_FLOW.COST_STATUS]).toBe('unpriced');
    expect(priced!.SpanAttributes[TRACE_FLOW.COST_REASONS]).toBe('service_tier_rate_missing');
    expect(priced!.SpanAttributes[GEN_AI_COST.TOTAL]).toBeUndefined();
    trace.SpanAttributes[CLI_PROXY.RESPONSE_SERVICE_TIER] = 'standard';
    trace.SpanAttributes[GEN_AI_USAGE.MISSING] = 'true';
    for (const key of Object.keys(trace.SpanAttributes)) {
      if (key.startsWith('gen_ai.usage.') && key !== GEN_AI_USAGE.MISSING)
        delete trace.SpanAttributes[key];
    }
    [priced] = await priceImportedTraces([trace], env.MODEL_PRICING);
    expect(priced!.SpanAttributes[TRACE_FLOW.COST_STATUS]).toBe('unpriced');
    expect(priced!.SpanAttributes[TRACE_FLOW.COST_REASONS]).toBe('usage_missing');
    expect(priced!.SpanAttributes[GEN_AI_COST.TOTAL]).toBeUndefined();
  });
});
