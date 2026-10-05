import {
  convertOpenRouterModelPricing,
  findOpenRouterModel,
  indexOpenRouterModels,
  OPENROUTER_MODELS_URL,
  OPENROUTER_PRICING_TTL_SECONDS,
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

async function fetchOpenRouterModels(): Promise<Map<string, OpenRouterModel>> {
  const now = Date.now();
  if (modelsCache && now - cacheTimestamp < CACHE_TTL_MS) {
    return modelsCache;
  }

  const response = await fetch(OPENROUTER_MODELS_URL);
  if (!response.ok) {
    throw new Error(`OpenRouter API error: ${response.status}`);
  }

  const data: OpenRouterModelsResponse = await response.json();
  modelsCache = indexOpenRouterModels(data.data);
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

    const orModel = findOpenRouterModel(models, model);

    if (!orModel) {
      return null;
    }

    const pricing = convertOpenRouterModelPricing(orModel);

    const key = cacheKey ?? `pricing:openrouter:${model}`;
    await kv.put(key, JSON.stringify(pricing), {
      expirationTtl: OPENROUTER_PRICING_TTL_SECONDS,
    });

    return pricing;
  } catch (error) {
    console.error('Failed to fetch OpenRouter pricing:', error);
    return null;
  }
}
