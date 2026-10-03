import type { ModelPricing, ModelRates, ServiceTierPricing } from './pricing';

export const SERVICE_TIERS = ['flex', 'priority', 'batch'] as const;

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Invalid model pricing record');
  return value as Record<string, unknown>;
}

function rate(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new Error('Pricing rates must be finite and nonnegative');
  return value;
}

function parseRates(raw: unknown): ModelRates {
  const value = object(raw);
  const rates: ModelRates = {
    promptCostPerMillion: rate(value.promptCostPerMillion),
    completionCostPerMillion: rate(value.completionCostPerMillion),
  };
  for (const key of [
    'cacheReadCostPerMillion',
    'cacheWriteCostPerMillion',
    'cacheWrite1hCostPerMillion',
    'reasoningCostPerMillion',
  ] as const) {
    if (value[key] !== undefined) rates[key] = rate(value[key]);
  }
  if (value.contextTier !== undefined) {
    const tier = object(value.contextTier);
    const threshold = tier.thresholdTokens;
    if (
      typeof threshold !== 'number' ||
      !Number.isSafeInteger(threshold) ||
      threshold <= 0 ||
      tier.contextTier !== undefined
    ) {
      throw new Error('Invalid pricing context threshold');
    }
    rates.contextTier = { ...parseRates(tier), thresholdTokens: threshold };
  }
  return rates;
}

export function parseModelPricing(raw: unknown): ModelPricing {
  const value = object(raw);
  const source = value.source;
  if (
    source !== 'manual' &&
    source !== 'openrouter' &&
    source !== 'default' &&
    source !== 'models.dev'
  )
    throw new Error('Invalid pricing source');
  const updatedAt = value.updatedAt;
  if (typeof updatedAt !== 'number' || !Number.isSafeInteger(updatedAt) || updatedAt < 0)
    throw new Error('Invalid pricing catalog version');
  const pricing: ModelPricing = { ...parseRates(value), source, updatedAt };
  if (value.serviceTiers !== undefined) {
    const tiers = object(value.serviceTiers);
    pricing.serviceTiers = {};
    for (const [key, rawTier] of Object.entries(tiers)) {
      if (key !== 'flex' && key !== 'priority' && key !== 'batch')
        throw new Error('Unsupported pricing service tier');
      const tier = object(rawTier);
      if (typeof tier.referenceUrl !== 'string' || !tier.referenceUrl.startsWith('https://'))
        throw new Error('Service tier pricing requires HTTPS provider documentation');
      const referenceUrl = new URL(tier.referenceUrl).href;
      const parsed: ServiceTierPricing = { ...parseRates(tier), referenceUrl };
      pricing.serviceTiers[key] = parsed;
    }
  }
  return pricing;
}

export function serializeModelPricing(record: ModelPricing): string {
  return JSON.stringify(parseModelPricing(record));
}
