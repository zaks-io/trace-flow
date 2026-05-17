import { GEN_AI_COST } from '../keys';
import type { CostBreakdown } from './types';

function microdollarsToString(microdollars: number): string {
  return parseFloat((microdollars / 1_000_000).toFixed(8)).toString();
}

/**
 * Cost attributes derived from the pricing module's CostBreakdown. Conditional
 * keys (cache_read, cache_creation, reasoning) are emitted only when non-zero,
 * matching the prior inline behavior. `prompt_baseline` and `cache_impact`
 * always emit when a CostBreakdown is present.
 *
 * `upstream` lives on `tokens.upstreamCost`, not pricing — see `upstreamCostAttribute`.
 */
export function costAttributes(cost: CostBreakdown): Record<string, string> {
  const out: Record<string, string> = {};
  out[GEN_AI_COST.INPUT] = microdollarsToString(cost.inputCostMicrodollars);
  out[GEN_AI_COST.OUTPUT] = microdollarsToString(cost.outputCostMicrodollars);
  out[GEN_AI_COST.TOTAL] = microdollarsToString(cost.totalCostMicrodollars);
  if (cost.cacheReadCostMicrodollars > 0) {
    out[GEN_AI_COST.CACHE_READ] = microdollarsToString(cost.cacheReadCostMicrodollars);
  }
  if (cost.cacheWriteCostMicrodollars > 0) {
    out[GEN_AI_COST.CACHE_CREATION] = microdollarsToString(cost.cacheWriteCostMicrodollars);
  }
  if (cost.reasoningCostMicrodollars > 0) {
    out[GEN_AI_COST.REASONING] = microdollarsToString(cost.reasoningCostMicrodollars);
  }
  out[GEN_AI_COST.PROMPT_BASELINE] = microdollarsToString(cost.promptBaselineCostMicrodollars);
  out[GEN_AI_COST.CACHE_IMPACT] = microdollarsToString(cost.cacheImpactCostMicrodollars);
  return out;
}

/**
 * Upstream-reported cost (OpenRouter `usage.cost`). Lives on `tokens.upstreamCost`,
 * separate from the pricing-derived CostBreakdown. Normalized through the same
 * microdollar-string formatter so all `gen_ai.cost.*` attributes look the same
 * in storage — fixes the pre-refactor inconsistency where `upstream` was raw
 * `String(...)` while siblings were formatted dollars.
 *
 * NOTE: input is dollars (provider sends a float), not microdollars.
 */
export function upstreamCostAttribute(upstreamCost: number | undefined): Record<string, string> {
  if (upstreamCost === undefined) return {};
  const microdollars = Math.round(upstreamCost * 1_000_000);
  return { [GEN_AI_COST.UPSTREAM]: microdollarsToString(microdollars) };
}
