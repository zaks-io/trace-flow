import type { ModelPricing } from '@trace-flow/pricing';

interface OpenRouterModel {
  id: string;
  pricing: {
    prompt: string;
    completion: string;
    input_cache_read?: string;
    input_cache_write?: string;
    internal_reasoning?: string;
  };
}

interface OpenRouterModelsResponse {
  data: OpenRouterModel[];
}

// In-memory cache for the worker lifecycle
let modelsCache: Map<string, OpenRouterModel> | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes in-memory

// KV cache TTL: 1 year (prices rarely change)
const KV_CACHE_TTL_SECONDS = 31536000;

async function fetchOpenRouterModels(): Promise<Map<string, OpenRouterModel>> {
  const now = Date.now();
  if (modelsCache && now - cacheTimestamp < CACHE_TTL_MS) {
    return modelsCache;
  }

  const response = await fetch('https://openrouter.ai/api/v1/models');
  if (!response.ok) {
    throw new Error(`OpenRouter API error: ${response.status}`);
  }

  const data: OpenRouterModelsResponse = await response.json();
  modelsCache = new Map(data.data.map((m): [string, OpenRouterModel] => [m.id, m]));
  cacheTimestamp = now;
  return modelsCache;
}

function convertPricing(orModel: OpenRouterModel): ModelPricing {
  // OpenRouter returns prices as strings like "0.000003" (dollars per token)
  // Convert to microdollars per million: price * 1_000_000 * 1_000_000
  const promptCostPerMillion = Math.round(parseFloat(orModel.pricing.prompt) * 1_000_000_000_000);
  const completionCostPerMillion = Math.round(
    parseFloat(orModel.pricing.completion) * 1_000_000_000_000,
  );

  const cacheReadCostPerMillion = orModel.pricing.input_cache_read
    ? Math.round(parseFloat(orModel.pricing.input_cache_read) * 1_000_000_000_000)
    : undefined;

  const cacheWriteCostPerMillion = orModel.pricing.input_cache_write
    ? Math.round(parseFloat(orModel.pricing.input_cache_write) * 1_000_000_000_000)
    : undefined;

  const reasoningCostPerMillion = orModel.pricing.internal_reasoning
    ? Math.round(parseFloat(orModel.pricing.internal_reasoning) * 1_000_000_000_000)
    : undefined;

  return {
    promptCostPerMillion,
    completionCostPerMillion,
    cacheReadCostPerMillion,
    cacheWriteCostPerMillion,
    reasoningCostPerMillion,
    updatedAt: Date.now(),
    source: 'openrouter',
  };
}

export async function fetchOpenRouterPricing(
  model: string,
  kv: KVNamespace,
  cacheKey?: string,
): Promise<ModelPricing | null> {
  try {
    const models = await fetchOpenRouterModels();

    // Try exact match first
    let orModel = models.get(model);

    if (!orModel) {
      // Try matching by suffix — prefer the longest (most specific) match
      let bestLen = 0;
      for (const [id, m] of models) {
        const idName = id.split('/').pop() ?? '';
        if (id.endsWith(model) || model.endsWith(idName)) {
          const matchLen = Math.max(model.length, id.length);
          if (matchLen > bestLen) {
            bestLen = matchLen;
            orModel = m;
          }
        }
      }
    }

    if (!orModel) {
      return null;
    }

    const pricing = convertPricing(orModel);

    // Cache the fetched pricing in KV for future requests (1 year TTL)
    const key = cacheKey ?? `pricing:openrouter:${model}`;
    await kv.put(key, JSON.stringify(pricing), { expirationTtl: KV_CACHE_TTL_SECONDS });

    return pricing;
  } catch (error) {
    console.error('Failed to fetch OpenRouter pricing:', error);
    return null;
  }
}
