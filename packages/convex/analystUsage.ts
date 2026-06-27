/**
 * Pure aggregation of the Analyst agent's own LLM usage across a thread's messages.
 *
 * Token counts come from the agent component's persisted `MessageDoc.usage`. The
 * charged dollar cost comes from OpenRouter's usage accounting, which the analyst
 * enables via `usage: { include: true }` (see `buildOpenRouterExtraBody`); it lands
 * in `providerMetadata.openrouter.usage.cost`. We sum what the provider reports
 * rather than re-deriving cost from token counts and a rate table.
 */

export interface MessageUsageInput {
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    reasoningTokens?: number;
    cachedInputTokens?: number;
  };
  providerMetadata?: unknown;
}

export interface UsageTotal {
  totalTokens: number;
  totalCost: number;
  /** Whether any priced message was found — distinguishes "$0" from "no cost data". */
  hasCost: boolean;
}

export function sumAnalystUsage(messages: MessageUsageInput[]): UsageTotal {
  let totalTokens = 0;
  let totalCost = 0;
  let hasCost = false;

  for (const message of messages) {
    const tokens = readNumber(message.usage?.totalTokens);
    if (tokens !== undefined) totalTokens += tokens;

    const cost = openRouterCost(message.providerMetadata);
    if (cost !== undefined) {
      totalCost += cost;
      hasCost = true;
    }
  }

  return { totalTokens, totalCost, hasCost };
}

/** OpenRouter reports the charged cost (USD) at `providerMetadata.openrouter.usage.cost`. */
export function openRouterCost(providerMetadata: unknown): number | undefined {
  if (!isRecord(providerMetadata)) return undefined;
  const openrouter = providerMetadata.openrouter;
  if (!isRecord(openrouter)) return undefined;
  const usage = openrouter.usage;
  if (!isRecord(usage)) return undefined;
  return readNumber(usage.cost);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
