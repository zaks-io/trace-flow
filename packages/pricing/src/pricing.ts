import type { LLMTokenUsage } from '@trace-flow/types';

/**
 * Per-message server-side cost calculation, shared by the proxy consumer and the agent consumer.
 * This package prices ONE message from its tokens + a resolved {@link ModelPricing} record and
 * nothing else — it does not own subagent dedup. The canonical Agent Session Authoring Cost rule
 * (count nested/sidechain usage, count tool-result subagent usage only when no matching sidechain
 * exists) lives once in SQL as `agent_priced_usage.pipe`, the sole runtime path for aggregation.
 */

/** Rates that replace the base rates once a message's input context reaches `thresholdTokens`. */
export interface ContextTierPricing {
  /** Input-token context size at or above which the tier rates apply (inclusive). */
  thresholdTokens: number;
  promptCostPerMillion: number;
  completionCostPerMillion: number;
  cacheReadCostPerMillion?: number;
  cacheWriteCostPerMillion?: number;
  cacheWrite1hCostPerMillion?: number;
  reasoningCostPerMillion?: number;
}

export interface ModelPricing {
  promptCostPerMillion: number;
  completionCostPerMillion: number;
  cacheReadCostPerMillion?: number;
  cacheWriteCostPerMillion?: number;
  cacheWrite1hCostPerMillion?: number;
  reasoningCostPerMillion?: number;
  /**
   * Context-tier override. `gpt-5.5` prices roughly 2x above a 200k-token context, and Codex runs
   * near a 258k window, so a flat rate would undercount those messages. When the message's input
   * context reaches `contextTier.thresholdTokens`, the tier rates replace the base rates for that
   * one message (any tier rate left unset falls back to the matching base rate).
   */
  contextTier?: ContextTierPricing;
  updatedAt: number;
  source: 'manual' | 'openrouter' | 'default' | 'models.dev';
}

export interface CostBreakdown {
  inputCostMicrodollars: number;
  outputCostMicrodollars: number;
  cacheReadCostMicrodollars: number;
  cacheWriteCostMicrodollars: number;
  reasoningCostMicrodollars: number;
  promptBaselineCostMicrodollars: number;
  cacheImpactCostMicrodollars: number;
  totalCostMicrodollars: number;
}

/**
 * Extracts the model prefix by removing date suffixes (e.g., -20250929).
 * This allows pricing to be stored by model family rather than specific snapshots.
 */
function extractModelPrefix(model: string): string | null {
  // Match date suffix pattern: -YYYYMMDD at end of string.
  // String#match (not RegExp#exec) is deliberate: equivalent for this non-global pattern, and the
  // repo security hook false-flags the literal `.exec(` token as child_process.exec.
  // eslint-disable-next-line @typescript-eslint/prefer-regexp-exec
  const match = model.match(/^(.+)-\d{8}$/);
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

/**
 * Resolves the rates to charge for this message. With no `contextTier`, or with an input context
 * below the tier threshold, the base rates apply unchanged. At or above the threshold, the tier
 * rates replace the base rates (each tier rate falling back to its base counterpart when unset).
 */
function resolveTierPricing(tokens: LLMTokenUsage, pricing: ModelPricing): ModelPricing {
  const tier = pricing.contextTier;
  if (!tier) {
    return pricing;
  }

  const contextTokens = tokens.promptTokens ?? 0;
  if (contextTokens < tier.thresholdTokens) {
    return pricing;
  }

  return {
    ...pricing,
    promptCostPerMillion: tier.promptCostPerMillion,
    completionCostPerMillion: tier.completionCostPerMillion,
    cacheReadCostPerMillion: tier.cacheReadCostPerMillion ?? pricing.cacheReadCostPerMillion,
    cacheWriteCostPerMillion: tier.cacheWriteCostPerMillion ?? pricing.cacheWriteCostPerMillion,
    cacheWrite1hCostPerMillion:
      tier.cacheWrite1hCostPerMillion ?? pricing.cacheWrite1hCostPerMillion,
    reasoningCostPerMillion: tier.reasoningCostPerMillion ?? pricing.reasoningCostPerMillion,
  };
}

export function calculateCost(tokens: LLMTokenUsage, pricing: ModelPricing): CostBreakdown {
  const effective = resolveTierPricing(tokens, pricing);

  const promptTokens = tokens.promptTokens ?? 0;
  const uncachedInputTokens =
    tokens.uncachedInputTokens ??
    Math.max(0, promptTokens - (tokens.cacheReadTokens ?? 0) - (tokens.cacheCreationTokens ?? 0));
  const completionTokens = tokens.completionTokens ?? 0;
  const cacheReadTokens = tokens.cacheReadTokens ?? 0;
  const cacheCreationTokens = tokens.cacheCreationTokens ?? 0;
  const reasoningTokens = tokens.reasoningTokens ?? 0;

  const cacheReadCostPerMillion =
    effective.cacheReadCostPerMillion ?? effective.promptCostPerMillion;
  const cacheWriteCostPerMillion =
    effective.cacheWriteCostPerMillion ?? effective.promptCostPerMillion;
  const reasoningCostPerMillion =
    effective.reasoningCostPerMillion ?? effective.completionCostPerMillion;

  // Calculate costs in microdollars
  // Formula: (tokens * pricePerMillion) / 1_000_000
  const inputCostMicrodollars = Math.round(
    (uncachedInputTokens * effective.promptCostPerMillion) / 1_000_000,
  );
  const outputCostMicrodollars = Math.round(
    (completionTokens * effective.completionCostPerMillion) / 1_000_000,
  );
  const cacheReadCostMicrodollars = Math.round(
    (cacheReadTokens * cacheReadCostPerMillion) / 1_000_000,
  );

  // Tiered cache write pricing: if 5m/1h breakdown available, price each tier separately
  let cacheWriteCostMicrodollars: number;
  if (tokens.cacheCreation5mTokens !== undefined || tokens.cacheCreation1hTokens !== undefined) {
    const tokens5m = tokens.cacheCreation5mTokens ?? 0;
    const tokens1h = tokens.cacheCreation1hTokens ?? 0;
    // Falls back: 1h tier rate → 5m tier rate → prompt rate
    const cost1h = effective.cacheWrite1hCostPerMillion ?? cacheWriteCostPerMillion;
    cacheWriteCostMicrodollars =
      Math.round((tokens5m * cacheWriteCostPerMillion) / 1_000_000) +
      Math.round((tokens1h * cost1h) / 1_000_000);
  } else {
    cacheWriteCostMicrodollars = Math.round(
      (cacheCreationTokens * cacheWriteCostPerMillion) / 1_000_000,
    );
  }

  const reasoningCostMicrodollars = Math.round(
    (reasoningTokens * reasoningCostPerMillion) / 1_000_000,
  );

  const promptBaselineCostMicrodollars = Math.round(
    (promptTokens * effective.promptCostPerMillion) / 1_000_000,
  );
  // Positive values mean caching reduced prompt-side spend; negative values mean warmup writes
  // cost more than the no-cache baseline for this request.
  const cacheImpactCostMicrodollars =
    promptBaselineCostMicrodollars -
    (inputCostMicrodollars + cacheReadCostMicrodollars + cacheWriteCostMicrodollars);

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
    promptBaselineCostMicrodollars,
    cacheImpactCostMicrodollars,
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
