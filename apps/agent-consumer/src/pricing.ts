import type { AgentMessageQueueFact, AgentSource, LLMTokenUsage } from '@trace-flow/types';
import {
  calculateCost,
  getPricing,
  microdollarsToDollars,
  type ModelPricing,
} from '@trace-flow/pricing';

/**
 * Maps an agent `source` to the first-party pricing provider its model labels are cataloged under.
 * The models.dev import (2d) pins first-party `anthropic` / `openai` entries; Cursor house models
 * are normalized there as a fast-follow, so until then a Cursor message resolves to no rate and
 * prices to `null` (graceful, source-agnostic — never a wrong rate).
 */
const SOURCE_PROVIDER: Record<AgentSource, string> = {
  claude: 'anthropic',
  codex: 'openai',
  cursor: 'cursor',
};

/**
 * Resolves model pricing once per `(provider, model)` for the lifetime of one queue batch. A
 * backfill of thousands of messages across a handful of models makes O(distinct models) KV reads,
 * never one read per message. A resolved `null` is cached too, so unpriced models are not re-fetched.
 */
export class PriceCache {
  private readonly cache = new Map<string, ModelPricing | null>();

  constructor(private readonly kv: KVNamespace) {}

  async resolve(provider: string, model: string): Promise<ModelPricing | null> {
    const key = `${provider}:${model}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const pricing = await getPricing(this.kv, provider, model);
    this.cache.set(key, pricing);
    return pricing;
  }
}

/** Agent Message token fields → the shared {@link LLMTokenUsage} pricing input. */
function toTokenUsage(fact: AgentMessageQueueFact): LLMTokenUsage {
  return {
    // Full input context drives the context-tier threshold (e.g. gpt-5.5 above 200k); the billed
    // input is the explicit uncached + cache components below, so this never double-counts.
    promptTokens: fact.input_tokens + fact.cache_read_tokens + fact.cache_creation_tokens,
    uncachedInputTokens: fact.input_tokens,
    completionTokens: fact.output_tokens,
    cacheReadTokens: fact.cache_read_tokens,
    cacheCreationTokens: fact.cache_creation_tokens,
    cacheCreation5mTokens: fact.cache_creation_5m_tokens,
    cacheCreation1hTokens: fact.cache_creation_1h_tokens,
    reasoningTokens: fact.reasoning_tokens,
  };
}

/**
 * Server-side cost for one Agent Message in dollars, or `null` when it cannot be priced honestly:
 * the source had no usable token data (`token_coverage === 'missing'`) or the model has no catalog
 * rate. `cost_usd` is the only Nullable column; a null here becomes a null at rest, not a `0`.
 */
export async function priceMessage(
  fact: AgentMessageQueueFact,
  source: AgentSource,
  cache: PriceCache,
): Promise<number | null> {
  if (fact.token_coverage === 'missing') {
    return null;
  }
  const provider = SOURCE_PROVIDER[source];
  const pricing = await cache.resolve(provider, fact.model);
  if (!pricing) {
    return null;
  }
  const { totalCostMicrodollars } = calculateCost(toTokenUsage(fact), pricing);
  return microdollarsToDollars(totalCostMicrodollars);
}
