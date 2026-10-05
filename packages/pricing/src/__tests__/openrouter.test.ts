import { describe, expect, it } from 'vitest';
import {
  convertOpenRouterModelPricing,
  convertOpenRouterModelRates,
  findOpenRouterModel,
  indexOpenRouterModels,
  parseOpenRouterModelId,
} from '../openrouter';

const openRouterModel = {
  id: 'anthropic/claude-3-5-sonnet',
  pricing: {
    prompt: '0.000003',
    completion: '0.000015',
    input_cache_read: '0.0000003',
    input_cache_write: '0.00000375',
    internal_reasoning: '0.000015',
  },
};

describe('OpenRouter pricing conversion', () => {
  it('parses provider and model names', () => {
    expect(parseOpenRouterModelId(openRouterModel.id)).toEqual({
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
    });
    expect(parseOpenRouterModelId('missing-provider')).toBeNull();
  });

  it('converts OpenRouter token prices to microdollars per million tokens', () => {
    expect(convertOpenRouterModelRates(openRouterModel)).toEqual({
      promptCostPerMillion: 3000000,
      completionCostPerMillion: 15000000,
      cacheReadCostPerMillion: 300000,
      cacheWriteCostPerMillion: 3750000,
      reasoningCostPerMillion: 15000000,
    });
  });

  it('builds a runtime pricing record', () => {
    expect(convertOpenRouterModelPricing(openRouterModel, 123)).toEqual({
      promptCostPerMillion: 3000000,
      completionCostPerMillion: 15000000,
      cacheReadCostPerMillion: 300000,
      cacheWriteCostPerMillion: 3750000,
      reasoningCostPerMillion: 15000000,
      updatedAt: 123,
      source: 'openrouter',
    });
  });

  it('retains free output and optional zero rates for decisions', () => {
    expect(
      convertOpenRouterModelRates({
        id: 'typesafe/jev-1.13',
        pricing: { prompt: '0.000000042', completion: '0', input_cache_read: '0' },
      }),
    ).toMatchObject({
      promptCostPerMillion: 42_000,
      completionCostPerMillion: 0,
      cacheReadCostPerMillion: 0,
    });
  });

  it.each(['', ' ', '-1', 'Infinity', 'NaN', '0.042USD', '0x10', '1e100'])(
    'rejects invalid required rate %j',
    (prompt) => {
      expect(() =>
        convertOpenRouterModelRates({
          ...openRouterModel,
          pricing: { ...openRouterModel.pricing, prompt },
        }),
      ).toThrow('OpenRouter pricing rates');
    },
  );

  it('rejects invalid optional rates instead of caching sentinel values', () => {
    expect(() =>
      convertOpenRouterModelRates({
        ...openRouterModel,
        pricing: { ...openRouterModel.pricing, input_cache_read: '-1' },
      }),
    ).toThrow('OpenRouter pricing rates');
  });
});

describe('OpenRouter model identities', () => {
  const jev = {
    id: 'typesafe/jev-1.13',
    canonical_slug: 'typesafe/jev-1.13-20260917',
    pricing: { prompt: '0.000000042', completion: '0' },
  };
  const alias = {
    id: '~typesafe/jev-latest',
    canonical_slug: '~typesafe/jev-latest',
    alias_target: { slug: jev.id },
    pricing: { prompt: '0.0001', completion: '0' },
  };

  it('indexes ids, canonical slugs, and alias targets independent of catalog order', () => {
    const index = indexOpenRouterModels([alias, jev]);
    for (const id of [jev.id, jev.canonical_slug, alias.id, 'jev-1.13', 'jev-latest']) {
      expect(findOpenRouterModel(index, id)).toBe(jev);
    }
  });

  it('does not guess unknown versions or borrow a different provider namespace', () => {
    const index = indexOpenRouterModels([jev, alias]);
    for (const id of [
      'typesafe/jev-1.14',
      'jev-1.14',
      'typesafe/jev-1.13-20261005',
      'other/jev-1.13',
    ]) {
      expect(findOpenRouterModel(index, id)).toBeUndefined();
    }
  });

  it('leaves ambiguous bare model names unresolved', () => {
    const index = indexOpenRouterModels([
      jev,
      { ...jev, id: 'other/jev-1.13', canonical_slug: undefined },
    ]);
    expect(findOpenRouterModel(index, 'jev-1.13')).toBeUndefined();
    expect(findOpenRouterModel(index, jev.id)).toBe(jev);
  });

  it('skips invalid catalog rates while retaining other valid entries', () => {
    const index = indexOpenRouterModels([
      jev,
      { id: 'typesafe/invalid', pricing: { prompt: '-1', completion: '0' } },
    ]);
    expect(index.get(jev.id)).toBe(jev);
    expect(index.has('typesafe/invalid')).toBe(false);
  });

  it.each([false, true])(
    'keeps real model ids ahead of batch canonical names, reversed=%s',
    (reverse) => {
      const regular = {
        id: 'openai/gpt-4o',
        pricing: { prompt: '0.0000025', completion: '0.00001' },
      };
      const batch = {
        id: `${regular.id}:batch`,
        canonical_slug: regular.id,
        pricing: { prompt: '0.00000125', completion: '0.000005' },
      };
      const index = indexOpenRouterModels(reverse ? [batch, regular] : [regular, batch]);
      expect(index.get(regular.id)).toBe(regular);
      expect(index.get(batch.id)).toBe(batch);
      expect(findOpenRouterModel(index, 'gpt-4o')).toBe(regular);
    },
  );

  it('does not choose between models sharing a secondary canonical name', () => {
    const batch = { ...jev, id: `${jev.id}:batch` };
    for (const models of [
      [jev, batch],
      [batch, jev],
    ]) {
      const index = indexOpenRouterModels(models);
      expect(index.has(jev.canonical_slug)).toBe(false);
      expect(index.get(jev.id)).toBe(jev);
      expect(index.get(batch.id)).toBe(batch);
    }
  });

  it('leaves invalid real ids unpriced instead of borrowing their batch rate', () => {
    const invalid = { ...jev, pricing: { prompt: '-1', completion: '0' } };
    const batch = { ...jev, id: `${jev.id}:batch`, canonical_slug: jev.id };
    expect(indexOpenRouterModels([invalid, batch]).has(jev.id)).toBe(false);
  });
});
