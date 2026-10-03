import {
  CLI_PROXY,
  GEN_AI,
  GEN_AI_COST,
  GEN_AI_USAGE,
  TRACE_FLOW,
  SOURCE_IMPORTED_EXECUTION,
  costAttributes,
} from '@trace-flow/otel-conventions';
import {
  priceCanonicalUsage,
  resolvePricing,
  type CanonicalUsage,
  type CanonicalCost,
  type PricingStore,
  type ResolvedPricing,
} from '@trace-flow/pricing';
import type { TinybirdTrace } from '@trace-flow/types';

function canonicalUsage(attributes: Record<string, string>): CanonicalUsage | null {
  if (attributes[GEN_AI_USAGE.MISSING] === 'true') return null;
  const count = (key: string): number => {
    const value = attributes[key];
    if (value === undefined || !/^(0|[1-9][0-9]*)$/.test(value))
      throw new Error('Imported token bucket is missing or malformed');
    const result = Number(value);
    if (!Number.isSafeInteger(result)) throw new Error('Imported token bucket is out of range');
    return result;
  };
  return {
    inputUncached: count(GEN_AI_USAGE.INPUT_TOKENS_UNCACHED),
    cacheRead: count(GEN_AI_USAGE.CACHE_READ_INPUT_TOKENS),
    cacheWrite: count(GEN_AI_USAGE.CACHE_CREATION_INPUT_TOKENS),
    outputNonReasoning: count(GEN_AI_USAGE.OUTPUT_TOKENS_NON_REASONING),
    reasoning: count(GEN_AI_USAGE.REASONING_TOKENS),
    unclassified: count(GEN_AI_USAGE.UNCLASSIFIED_TOKENS),
  };
}

function estimateAttributes(
  cost: CanonicalCost,
  resolved: ResolvedPricing | null,
): Record<string, string> {
  const attributes: Record<string, string> = {
    [TRACE_FLOW.COST_STATUS]: cost.status,
    [TRACE_FLOW.COST_METHOD]: 'imported_catalog/2',
    [TRACE_FLOW.COST_UNIT]: 'USD',
    [TRACE_FLOW.COST_PRICED_TOKENS]: String(cost.pricedTokens),
  };
  if (cost.reasons.length) attributes[TRACE_FLOW.COST_REASONS] = cost.reasons.join(',');
  if (resolved) {
    attributes[TRACE_FLOW.COST_CATALOG_KEY] = resolved.key;
    attributes[TRACE_FLOW.COST_CATALOG_VERSION] =
      `${resolved.pricing.source}@${resolved.pricing.updatedAt}`;
  }
  if (!cost.breakdown || !cost.rates) return attributes;
  attributes[TRACE_FLOW.COST_RATES] = JSON.stringify(cost.rates);
  Object.assign(attributes, costAttributes(cost.breakdown));
  // Explicit zero rates must survive serialization just like nonzero cache and reasoning rates.
  if (cost.rates.cacheRead !== undefined)
    attributes[GEN_AI_COST.CACHE_READ] = String(
      cost.breakdown.cacheReadCostMicrodollars / 1_000_000,
    );
  else delete attributes[GEN_AI_COST.CACHE_READ];
  if (cost.rates.cacheWrite !== undefined)
    attributes[GEN_AI_COST.CACHE_CREATION] = String(
      cost.breakdown.cacheWriteCostMicrodollars / 1_000_000,
    );
  else delete attributes[GEN_AI_COST.CACHE_CREATION];
  attributes[GEN_AI_COST.REASONING] = String(cost.breakdown.reasoningCostMicrodollars / 1_000_000);
  if (cost.reasons.some((reason) => reason.startsWith('cache_'))) {
    delete attributes[GEN_AI_COST.PROMPT_BASELINE];
    delete attributes[GEN_AI_COST.CACHE_IMPACT];
  }
  return attributes;
}

async function resolveImportedPricing(
  kv: PricingStore,
  provider: string,
  model: string,
): Promise<ResolvedPricing | null> {
  const resolved = await resolvePricing(kv, provider, model);
  if (resolved) return resolved;
  const catalogProvider =
    provider === 'codex' ? 'openai' : provider === 'claude' ? 'anthropic' : null;
  return catalogProvider ? resolvePricing(kv, catalogProvider, model) : null;
}

export async function priceImportedTraces(
  traces: TinybirdTrace[],
  kv: PricingStore,
): Promise<TinybirdTrace[]> {
  const catalog = new Map<string, Promise<ResolvedPricing | null>>();
  return Promise.all(
    traces.map(async (trace) => {
      const attributes = trace.SpanAttributes;
      if (attributes[TRACE_FLOW.SOURCE] !== SOURCE_IMPORTED_EXECUTION)
        throw new Error('Imported execution source is missing');
      if (
        Object.keys(attributes).some(
          (key) => key.startsWith('gen_ai.cost.') || key.startsWith('trace_flow.cost.'),
        )
      ) {
        throw new Error('Imported execution contains client-supplied costs');
      }
      const provider = attributes[GEN_AI.SYSTEM];
      if (!provider) throw new Error('Imported execution provider is missing');
      const model = attributes[GEN_AI.RESPONSE_MODEL];
      const usage = canonicalUsage(attributes);
      let resolved: ResolvedPricing | null = null;
      if (model) {
        const lookup = JSON.stringify([provider, model]);
        if (!catalog.has(lookup)) catalog.set(lookup, resolveImportedPricing(kv, provider, model));
        resolved = await catalog.get(lookup)!;
      }
      const cost = model
        ? priceCanonicalUsage(usage, resolved, {
            requested: attributes[CLI_PROXY.REQUEST_SERVICE_TIER],
            reported: attributes[CLI_PROXY.RESPONSE_SERVICE_TIER],
          })
        : {
            status: 'unpriced' as const,
            reasons: ['model_unreported' as const, ...(!usage ? ['usage_missing' as const] : [])],
            breakdown: null,
            rates: null,
            pricedTokens: 0,
          };
      return { ...trace, SpanAttributes: { ...attributes, ...estimateAttributes(cost, resolved) } };
    }),
  );
}
