import { describe, it, expect } from 'vitest';
import { microdollarsToDollars, type ModelPricing } from '@trace-flow/pricing';
import { PriceCache, priceMessage } from '../pricing';
import { makeKv } from './harness';
import { messageFact } from './factories';

const PRICING: ModelPricing = {
  promptCostPerMillion: 3,
  completionCostPerMillion: 15,
  updatedAt: 0,
  source: 'manual',
};

// gpt-5.5-style: rates double once the input context reaches 200k tokens. Rates are scaled so the
// `round(tokens * rate / 1e6)` microdollar math lands on exact integers, not a fixture's real price.
const TIERED: ModelPricing = {
  promptCostPerMillion: 100,
  completionCostPerMillion: 1000,
  contextTier: {
    thresholdTokens: 200_000,
    promptCostPerMillion: 200,
    completionCostPerMillion: 2000,
  },
  updatedAt: 0,
  source: 'manual',
};

describe('priceMessage', () => {
  it('prices a claude message via the anthropic catalog', async () => {
    const { kv } = makeKv({ 'pricing:anthropic:claude-opus-4-7': PRICING });
    const cost = await priceMessage(
      messageFact({ input_tokens: 1_000_000 }),
      'claude',
      new PriceCache(kv),
    );
    // 1M uncached input × $3/M = 3 microdollars.
    expect(cost).toBe(microdollarsToDollars(3));
  });

  it('returns null when token coverage is missing, before any KV read', async () => {
    const { kv, get } = makeKv({ 'pricing:anthropic:claude-opus-4-7': PRICING });
    const cost = await priceMessage(
      messageFact({ token_coverage: 'missing', input_tokens: 1_000_000 }),
      'claude',
      new PriceCache(kv),
    );
    expect(cost).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it('returns null when the model has no catalog rate', async () => {
    const { kv } = makeKv({});
    const cost = await priceMessage(
      messageFact({ model: 'mystery-model', input_tokens: 1_000_000 }),
      'claude',
      new PriceCache(kv),
    );
    expect(cost).toBeNull();
  });

  it('routes codex to the openai provider', async () => {
    const { kv, get } = makeKv({ 'pricing:openai:gpt-5.5-codex': PRICING });
    const cost = await priceMessage(
      messageFact({ model: 'gpt-5.5-codex', input_tokens: 1_000_000 }),
      'codex',
      new PriceCache(kv),
    );
    expect(get).toHaveBeenCalledWith('pricing:openai:gpt-5.5-codex', 'json');
    expect(cost).toBe(microdollarsToDollars(3));
  });

  it('prices cursor as null until its house models are normalized (2d)', async () => {
    const { kv } = makeKv({ 'pricing:anthropic:claude-opus-4-7': PRICING });
    const cost = await priceMessage(
      messageFact({ input_tokens: 1_000_000 }),
      'cursor',
      new PriceCache(kv),
    );
    expect(cost).toBeNull();
  });

  it('applies the base rate below the context-tier threshold', async () => {
    const { kv } = makeKv({ 'pricing:openai:gpt-5.5': TIERED });
    const cost = await priceMessage(
      messageFact({ model: 'gpt-5.5', input_tokens: 100_000 }),
      'codex',
      new PriceCache(kv),
    );
    // 100k × 100/M = 10 microdollars (base rate; context below the 200k threshold).
    expect(cost).toBe(microdollarsToDollars(10));
  });

  it('applies the tier rate at the context-tier threshold', async () => {
    const { kv } = makeKv({ 'pricing:openai:gpt-5.5': TIERED });
    const cost = await priceMessage(
      messageFact({ model: 'gpt-5.5', input_tokens: 200_000 }),
      'codex',
      new PriceCache(kv),
    );
    // 200k × 200/M = 40 microdollars (tier rate kicks in at the 200k threshold).
    expect(cost).toBe(microdollarsToDollars(40));
  });
});

describe('PriceCache', () => {
  it('reads the catalog once per distinct (provider, model)', async () => {
    const { kv, get } = makeKv({ 'pricing:anthropic:claude-opus-4-7': PRICING });
    const cache = new PriceCache(kv);

    await cache.resolve('anthropic', 'claude-opus-4-7');
    await cache.resolve('anthropic', 'claude-opus-4-7');

    expect(get).toHaveBeenCalledTimes(1);
  });

  it('caches a null resolution so unpriced models are not re-fetched', async () => {
    const { kv, get } = makeKv({});
    const cache = new PriceCache(kv);

    expect(await cache.resolve('anthropic', 'mystery-model')).toBeNull();
    expect(await cache.resolve('anthropic', 'mystery-model')).toBeNull();

    expect(get).toHaveBeenCalledTimes(1);
  });

  it('keeps distinct models in separate cache slots', async () => {
    const { kv, get } = makeKv({ 'pricing:anthropic:claude-opus-4-7': PRICING });
    const cache = new PriceCache(kv);

    await cache.resolve('anthropic', 'claude-opus-4-7');
    await cache.resolve('anthropic', 'claude-haiku-4-5');

    expect(get).toHaveBeenCalledTimes(2);
  });
});
