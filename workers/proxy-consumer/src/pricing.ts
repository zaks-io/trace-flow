import type { LLMTokenUsage } from '@trace-flow/types';

export interface ModelPricing {
  promptCostPerMillion: number;
  completionCostPerMillion: number;
  cacheReadCostPerMillion?: number;
  cacheWriteCostPerMillion?: number;
  reasoningCostPerMillion?: number;
  updatedAt: number;
  source: 'manual' | 'openrouter' | 'default';
}

interface CostBreakdown {
  inputCostMicrodollars: number;
  outputCostMicrodollars: number;
  cacheReadCostMicrodollars: number;
  cacheWriteCostMicrodollars: number;
  reasoningCostMicrodollars: number;
  totalCostMicrodollars: number;
}

/**
 * Extracts the model prefix by removing date suffixes (e.g., -20250929).
 * This allows pricing to be stored by model family rather than specific snapshots.
 */
function extractModelPrefix(model: string): string | null {
  // Match date suffix pattern: -YYYYMMDD at end of string
  const match = /^(.+)-\d{8}$/.exec(model);
  return match?.[1] ?? null;
}

export async function getPricing(
  kv: KVNamespace,
  provider: string,
  model: string,
): Promise<ModelPricing | null> {
  // Try exact match first
  const exactKey = `pricing:${provider}:${model}`;
  const exactMatch = await kv.get(exactKey, 'json');
  if (exactMatch) {
    return exactMatch as ModelPricing;
  }

  // Fall back to prefix match (without date suffix)
  const prefix = extractModelPrefix(model);
  if (prefix) {
    const prefixKey = `pricing:${provider}:${prefix}`;
    const prefixMatch = await kv.get(prefixKey, 'json');
    if (prefixMatch) {
      return prefixMatch as ModelPricing;
    }
  }

  return null;
}

export function calculateCost(tokens: LLMTokenUsage, pricing: ModelPricing): CostBreakdown {
  const promptTokens = tokens.promptTokens ?? 0;
  const completionTokens = tokens.completionTokens ?? 0;
  const cacheReadTokens = tokens.cacheReadTokens ?? 0;
  const cacheCreationTokens = tokens.cacheCreationTokens ?? 0;
  const reasoningTokens = tokens.reasoningTokens ?? 0;

  // For Anthropic (and some other providers), input_tokens includes cache_read_input_tokens.
  // We subtract cached tokens to avoid double-charging: once at full input rate, once at cache rate.
  // Use Math.max to handle edge cases where data might be inconsistent.
  const nonCachedPromptTokens = Math.max(0, promptTokens - cacheReadTokens);

  const cacheReadCostPerMillion = pricing.cacheReadCostPerMillion ?? pricing.promptCostPerMillion;
  const cacheWriteCostPerMillion = pricing.cacheWriteCostPerMillion ?? pricing.promptCostPerMillion;
  const reasoningCostPerMillion =
    pricing.reasoningCostPerMillion ?? pricing.completionCostPerMillion;

  // Calculate costs in microdollars
  // Formula: (tokens * pricePerMillion) / 1_000_000
  const inputCostMicrodollars = Math.round(
    (nonCachedPromptTokens * pricing.promptCostPerMillion) / 1_000_000,
  );
  const outputCostMicrodollars = Math.round(
    (completionTokens * pricing.completionCostPerMillion) / 1_000_000,
  );
  const cacheReadCostMicrodollars = Math.round(
    (cacheReadTokens * cacheReadCostPerMillion) / 1_000_000,
  );
  const cacheWriteCostMicrodollars = Math.round(
    (cacheCreationTokens * cacheWriteCostPerMillion) / 1_000_000,
  );
  const reasoningCostMicrodollars = Math.round(
    (reasoningTokens * reasoningCostPerMillion) / 1_000_000,
  );

  const totalCostMicrodollars =
    inputCostMicrodollars +
    outputCostMicrodollars +
    cacheReadCostMicrodollars +
    cacheWriteCostMicrodollars +
    reasoningCostMicrodollars;

  return {
    inputCostMicrodollars,
    outputCostMicrodollars,
    cacheReadCostMicrodollars,
    cacheWriteCostMicrodollars,
    reasoningCostMicrodollars,
    totalCostMicrodollars,
  };
}

export function microdollarsToDollars(microdollars: number): number {
  return microdollars / 1_000_000;
}

export function formatCostAsString(microdollars: number): string {
  // Format with up to 8 decimal places, stripping trailing zeros
  return parseFloat(microdollarsToDollars(microdollars).toFixed(8)).toString();
}
