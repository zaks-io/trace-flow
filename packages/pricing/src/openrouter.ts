import type { ModelPricing } from './pricing';

const OPENROUTER_PRICE_MULTIPLIER = 1_000_000_000_000;
export const OPENROUTER_MODELS_URL =
  'https://openrouter.ai/api/v1/models?output_modalities=text,decisions';
export const OPENROUTER_PRICING_TTL_SECONDS = 24 * 60 * 60;

export interface OpenRouterModel {
  id: string;
  canonical_slug?: string;
  alias_target?: { slug: string } | null;
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
  return price === undefined ? undefined : requiredPriceStringToMicrodollars(price);
}

function requiredPriceStringToMicrodollars(price: string): number {
  const numeric = typeof price === 'string' ? price.trim() : '';
  const value = /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(numeric) ? Number(numeric) : NaN;
  const rate = Math.round(value * OPENROUTER_PRICE_MULTIPLIER);
  if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(rate)) {
    throw new Error('OpenRouter pricing rates must be finite, nonnegative numeric strings');
  }
  return rate;
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

export function indexOpenRouterModels(models: OpenRouterModel[]): Map<string, OpenRouterModel> {
  const valid = new Map<string, OpenRouterModel>();
  const declaredIds = new Set<string>();
  for (const model of models) {
    try {
      if (!parseOpenRouterModelId(model.id)) continue;
      declaredIds.add(model.id);
      convertOpenRouterModelRates(model);
      valid.set(model.id, model);
    } catch {
      // A malformed catalog entry must not poison pricing for the remaining models.
    }
  }

  const index = new Map(valid);
  const canonicalModels = new Map<string, OpenRouterModel | null>();
  for (const model of valid.values()) {
    const target = model.alias_target?.slug;
    const resolved = target ? (valid.get(target) ?? model) : model;
    index.set(model.id, resolved);
    const canonical = model.canonical_slug;
    if (canonical && !declaredIds.has(canonical) && parseOpenRouterModelId(canonical)) {
      const existing = canonicalModels.get(canonical);
      canonicalModels.set(
        canonical,
        existing === undefined || existing?.id === resolved.id ? resolved : null,
      );
    }
  }
  // Batch variants can share a canonical slug with regular models. IDs take precedence,
  // and ambiguous secondary names must not select a rate based on catalog order.
  for (const [canonical, model] of canonicalModels) {
    if (model) index.set(canonical, model);
  }
  return index;
}

export function findOpenRouterModel(
  models: Map<string, OpenRouterModel>,
  model: string,
): OpenRouterModel | undefined {
  const exact = models.get(model);
  if (exact || model.includes('/')) return exact;

  // Native System One names omit the provider prefix; only a unique exact name is safe.
  let match: OpenRouterModel | undefined;
  for (const [id, entry] of models) {
    if (id.slice(id.lastIndexOf('/') + 1) !== model) continue;
    if (match && match.id !== entry.id) return undefined;
    match = entry;
  }
  return match;
}
