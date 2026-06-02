import {
  convertOpenRouterModelPricing,
  type ModelPricing,
  type OpenRouterModel,
} from '@trace-flow/pricing';

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

    const pricing = convertOpenRouterModelPricing(orModel);

    // Cache the fetched pricing in KV for future requests (1 year TTL)
    const key = cacheKey ?? `pricing:openrouter:${model}`;
    await kv.put(key, JSON.stringify(pricing), { expirationTtl: KV_CACHE_TTL_SECONDS });

    return pricing;
  } catch (error) {
    console.error('Failed to fetch OpenRouter pricing:', error);
    return null;
  }
}
