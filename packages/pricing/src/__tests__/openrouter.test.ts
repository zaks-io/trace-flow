import { describe, expect, it } from 'vitest';
import {
  convertOpenRouterModelPricing,
  convertOpenRouterModelRates,
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
});
