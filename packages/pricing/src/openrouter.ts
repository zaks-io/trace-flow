import type { ModelPricing } from './pricing';

const OPENROUTER_PRICE_MULTIPLIER = 1_000_000_000_000;

export interface OpenRouterModel {
  id: string;
  pricing: {
    prompt: string;
    completion: string;
    input_cache_read?: string;
    input_cache_write?: string;
    internal_reasoning?: string;
  };
}

export interface OpenRouterModelRates {
  promptCostPerMillion: number;
  completionCostPerMillion: number;
  cacheReadCostPerMillion?: number;
  cacheWriteCostPerMillion?: number;
  reasoningCostPerMillion?: number;
}

export function parseOpenRouterModelId(id: string): { provider: string; model: string } | null {
  const [provider, ...modelParts] = id.split('/');
  const model = modelParts.join('/');
  return provider && model ? { provider, model } : null;
}

function priceStringToMicrodollars(price: string | undefined): number | undefined {
  if (!price) return undefined;
  return Math.round(parseFloat(price) * OPENROUTER_PRICE_MULTIPLIER);
}

function requiredPriceStringToMicrodollars(price: string): number {
  return Math.round(parseFloat(price) * OPENROUTER_PRICE_MULTIPLIER);
}

export function convertOpenRouterModelRates(model: OpenRouterModel): OpenRouterModelRates {
  return {
    promptCostPerMillion: requiredPriceStringToMicrodollars(model.pricing.prompt),
    completionCostPerMillion: requiredPriceStringToMicrodollars(model.pricing.completion),
    cacheReadCostPerMillion: priceStringToMicrodollars(model.pricing.input_cache_read),
    cacheWriteCostPerMillion: priceStringToMicrodollars(model.pricing.input_cache_write),
    reasoningCostPerMillion: priceStringToMicrodollars(model.pricing.internal_reasoning),
  };
}

export function convertOpenRouterModelPricing(
  model: OpenRouterModel,
  updatedAt = Date.now(),
): ModelPricing {
  return {
    ...convertOpenRouterModelRates(model),
    updatedAt,
    source: 'openrouter',
  };
}
