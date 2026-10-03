import type { CostBreakdown, ModelRates, ResolvedPricing } from './pricing';

export interface CanonicalUsage {
  inputUncached: number;
  cacheRead: number;
  cacheWrite: number;
  outputNonReasoning: number;
  reasoning: number;
  unclassified: number;
}

export interface ServiceTierEvidence {
  requested?: string;
  reported?: string;
}

export type CanonicalCostStatus = 'priced' | 'partial' | 'unpriced';
export type CanonicalCostReason =
  | 'usage_missing'
  | 'model_unreported'
  | 'model_not_in_catalog'
  | 'service_tier_unreported'
  | 'service_tier_unsupported'
  | 'service_tier_rate_missing'
  | 'unclassified_tokens'
  | 'context_tier_unknown'
  | 'cache_read_rate_missing'
  | 'cache_write_rate_missing'
  | 'cache_write_ttl_unknown';

export interface AppliedRates {
  input: number;
  output: number;
  reasoning: number;
  cacheRead?: number;
  cacheWrite?: number;
  contextTierThresholdTokens?: number;
  serviceTier: string;
  referenceUrl?: string;
}

export interface CanonicalCost {
  status: CanonicalCostStatus;
  reasons: CanonicalCostReason[];
  breakdown: CostBreakdown | null;
  rates: AppliedRates | null;
  pricedTokens: number;
}

function unpriced(reasons: CanonicalCostReason[]): CanonicalCost {
  return {
    status: 'unpriced',
    reasons: [...new Set(reasons)].sort(),
    breakdown: null,
    rates: null,
    pricedTokens: 0,
  };
}

function validateRates(rates: ModelRates): void {
  for (const [name, value] of Object.entries(rates)) {
    if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) {
      throw new Error(`Invalid canonical pricing rate: ${name}`);
    }
  }
  if (
    !Number.isFinite(rates.promptCostPerMillion) ||
    !Number.isFinite(rates.completionCostPerMillion)
  ) {
    throw new Error('Canonical pricing requires finite input and output rates');
  }
  if (rates.contextTier) validateRates(rates.contextTier);
}

export function priceCanonicalUsage(
  usage: CanonicalUsage | null,
  resolved: ResolvedPricing | null,
  tier: ServiceTierEvidence,
): CanonicalCost {
  const reasons: CanonicalCostReason[] = [];
  if (!usage) reasons.push('usage_missing');
  if (!resolved) reasons.push('model_not_in_catalog');
  if (!usage || !resolved) return unpriced(reasons);

  for (const count of Object.values(usage)) {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid canonical token count');
  }
  const serviceTier = tier.reported;
  if (!serviceTier) return unpriced(['service_tier_unreported']);
  let selected: ModelRates = resolved.pricing;
  let reference: string | undefined;
  if (serviceTier !== 'default' && serviceTier !== 'standard') {
    if (serviceTier !== 'flex' && serviceTier !== 'priority' && serviceTier !== 'batch') {
      return unpriced(['service_tier_unsupported']);
    }
    const override = resolved.pricing.serviceTiers?.[serviceTier];
    if (!override) return unpriced(['service_tier_rate_missing']);
    if (!override.referenceUrl.startsWith('https://'))
      throw new Error('Service tier pricing requires provider documentation');
    selected = override;
    reference = override.referenceUrl;
  }
  validateRates(selected);

  const input = usage.inputUncached + usage.cacheRead + usage.cacheWrite;
  const total = input + usage.outputNonReasoning + usage.reasoning + usage.unclassified;
  if (!Number.isSafeInteger(total)) throw new Error('Canonical token total exceeds safe range');
  const context = selected.contextTier;
  if (
    context &&
    input < context.thresholdTokens &&
    input + usage.unclassified >= context.thresholdTokens
  ) {
    return unpriced(['context_tier_unknown', 'unclassified_tokens']);
  }
  const contextApplied = context && input >= context.thresholdTokens;
  const effective = contextApplied ? context : selected;
  const rates: AppliedRates = {
    input: effective.promptCostPerMillion,
    output: effective.completionCostPerMillion,
    // Canonical reasoning is part of output. An explicit separate rate may override it.
    reasoning: effective.reasoningCostPerMillion ?? effective.completionCostPerMillion,
    cacheRead: effective.cacheReadCostPerMillion,
    cacheWrite: effective.cacheWriteCostPerMillion,
    ...(contextApplied ? { contextTierThresholdTokens: context.thresholdTokens } : {}),
    serviceTier,
    ...(reference ? { referenceUrl: reference } : {}),
  };
  if (usage.unclassified > 0) reasons.push('unclassified_tokens');
  if (usage.cacheRead > 0 && rates.cacheRead === undefined) reasons.push('cache_read_rate_missing');
  if (usage.cacheWrite > 0 && rates.cacheWrite === undefined)
    reasons.push('cache_write_rate_missing');
  if (
    usage.cacheWrite > 0 &&
    effective.cacheWrite1hCostPerMillion !== undefined &&
    effective.cacheWrite1hCostPerMillion !== rates.cacheWrite
  ) {
    reasons.push('cache_write_ttl_unknown');
    rates.cacheWrite = undefined;
  }

  const cost = (tokens: number, rate: number | undefined) => {
    if (rate === undefined) return 0;
    const microdollars = Math.round((tokens * rate) / 1_000_000);
    if (!Number.isSafeInteger(microdollars))
      throw new Error('Canonical cost exceeds safe microdollar range');
    return microdollars;
  };
  const inputCostMicrodollars = cost(usage.inputUncached, rates.input);
  const outputCostMicrodollars = cost(usage.outputNonReasoning, rates.output);
  const reasoningCostMicrodollars = cost(usage.reasoning, rates.reasoning);
  const cacheReadCostMicrodollars = cost(usage.cacheRead, rates.cacheRead);
  const cacheWriteCostMicrodollars = cost(usage.cacheWrite, rates.cacheWrite);
  const pricedTokens =
    usage.inputUncached +
    usage.outputNonReasoning +
    usage.reasoning +
    (rates.cacheRead === undefined ? 0 : usage.cacheRead) +
    (rates.cacheWrite === undefined ? 0 : usage.cacheWrite);
  if (total > 0 && pricedTokens === 0) return unpriced(reasons);
  const promptBaselineCostMicrodollars = cost(input, rates.input);
  const breakdown: CostBreakdown = {
    inputCostMicrodollars,
    outputCostMicrodollars,
    reasoningCostMicrodollars,
    cacheReadCostMicrodollars,
    cacheWriteCostMicrodollars,
    totalCostMicrodollars:
      inputCostMicrodollars +
      outputCostMicrodollars +
      reasoningCostMicrodollars +
      cacheReadCostMicrodollars +
      cacheWriteCostMicrodollars,
    promptBaselineCostMicrodollars,
    cacheImpactCostMicrodollars:
      promptBaselineCostMicrodollars -
      inputCostMicrodollars -
      cacheReadCostMicrodollars -
      cacheWriteCostMicrodollars,
  };
  if (!Number.isSafeInteger(breakdown.totalCostMicrodollars))
    throw new Error('Canonical cost total exceeds safe microdollar range');
  return {
    status: reasons.length ? 'partial' : 'priced',
    reasons: [...new Set(reasons)].sort(),
    breakdown,
    rates,
    pricedTokens,
  };
}
