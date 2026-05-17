import type { LLMTokenUsage } from '@trace-flow/types';
import { PROVIDER_SCHEMAS } from './schemas';
import type { ProviderId, ProviderTokenSchema } from './types';

function matchIntField(body: string, field: string, lastMatchOnly: boolean): number | undefined {
  if (lastMatchOnly) {
    const pattern = new RegExp(`"${field}"\\s*:\\s*(\\d+)`, 'g');
    let last: number | undefined;
    for (const m of body.matchAll(pattern)) {
      if (m[1]) last = parseInt(m[1], 10);
    }
    return last;
  }
  const pattern = new RegExp(`"${field}"\\s*:\\s*(\\d+)`);
  const m = body.match(pattern);
  if (m?.[1]) return parseInt(m[1], 10);
  return undefined;
}

function firstIntMatch(
  body: string,
  fields: readonly string[],
  lastMatchOnly: boolean,
): number | undefined {
  for (const field of fields) {
    const value = matchIntField(body, field, lastMatchOnly);
    if (value !== undefined) return value;
  }
  return undefined;
}

// Scoped to the usage object so unrelated `"cost"` fields in model output don't match.
const UPSTREAM_COST_PATTERN = /"usage"[\s\S]*?"cost"\s*:\s*([0-9.eE+-]+)/;

function findUpstreamCost(body: string): number | undefined {
  const m = UPSTREAM_COST_PATTERN.exec(body);
  if (m?.[1]) return parseFloat(m[1]);
  return undefined;
}

/**
 * Schema-driven whole-body token extraction. Returns canonical LLMTokenUsage.
 *
 * Normalizations applied here:
 *  - Anthropic (promptIncludesCache=false): promptTokens = input + cacheRead + cacheCreation
 *  - Everyone else (promptIncludesCache=true): uncachedInputTokens = prompt - cacheRead - cacheCreation
 *  - Google (lastMatchOnly=true): each field uses the last regex match in the body
 *    (Google streams cumulative usageMetadata in every chunk).
 *  - When nested cache_creation (Anthropic ephemeral_5m / ephemeral_1h) is present but
 *    the top-level cache_creation_input_tokens is missing, the sum becomes cacheCreationTokens.
 */
export function parseTokenUsage(body: string, providerId: ProviderId): LLMTokenUsage | undefined {
  const schema = PROVIDER_SCHEMAS[providerId];
  return parseTokenUsageWithSchema(body, schema);
}

export function parseTokenUsageWithSchema(
  body: string,
  schema: ProviderTokenSchema,
): LLMTokenUsage | undefined {
  const inputTokens = firstIntMatch(body, schema.promptFields, schema.lastMatchOnly);
  const outputTokens = firstIntMatch(body, schema.completionFields, schema.lastMatchOnly);
  const totalTokens = schema.totalFields
    ? firstIntMatch(body, schema.totalFields, schema.lastMatchOnly)
    : undefined;

  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return undefined;
  }

  const cacheReadTokens = schema.cacheReadFields
    ? firstIntMatch(body, schema.cacheReadFields, schema.lastMatchOnly)
    : undefined;
  let cacheCreationTokens = schema.cacheCreationFields
    ? firstIntMatch(body, schema.cacheCreationFields, schema.lastMatchOnly)
    : undefined;
  const reasoningTokens = schema.reasoningFields
    ? firstIntMatch(body, schema.reasoningFields, schema.lastMatchOnly)
    : undefined;
  const upstreamCost = schema.hasUpstreamCost ? findUpstreamCost(body) : undefined;

  let cacheCreation5mTokens: number | undefined;
  let cacheCreation1hTokens: number | undefined;
  if (schema.nestedCacheCreation) {
    cacheCreation5mTokens = matchIntField(body, schema.nestedCacheCreation.field5m, false);
    cacheCreation1hTokens = matchIntField(body, schema.nestedCacheCreation.field1h, false);
    if (
      cacheCreationTokens === undefined &&
      (cacheCreation5mTokens !== undefined || cacheCreation1hTokens !== undefined)
    ) {
      cacheCreationTokens = (cacheCreation5mTokens ?? 0) + (cacheCreation1hTokens ?? 0);
    }
  }

  const result: LLMTokenUsage = {};

  let promptTokens: number | undefined = inputTokens;
  if (!schema.promptIncludesCache && inputTokens !== undefined) {
    promptTokens = inputTokens + (cacheReadTokens ?? 0) + (cacheCreationTokens ?? 0);
  }

  if (promptTokens !== undefined) result.promptTokens = promptTokens;

  if (inputTokens !== undefined) {
    result.uncachedInputTokens = schema.promptIncludesCache
      ? Math.max(0, inputTokens - (cacheReadTokens ?? 0) - (cacheCreationTokens ?? 0))
      : inputTokens;
  }

  if (outputTokens !== undefined) result.completionTokens = outputTokens;
  if (totalTokens !== undefined) result.totalTokens = totalTokens;
  if (cacheReadTokens !== undefined) result.cacheReadTokens = cacheReadTokens;
  if (cacheCreationTokens !== undefined) result.cacheCreationTokens = cacheCreationTokens;
  if (cacheCreation5mTokens !== undefined) result.cacheCreation5mTokens = cacheCreation5mTokens;
  if (cacheCreation1hTokens !== undefined) result.cacheCreation1hTokens = cacheCreation1hTokens;
  if (reasoningTokens !== undefined) result.reasoningTokens = reasoningTokens;
  if (upstreamCost !== undefined) result.upstreamCost = upstreamCost;

  // Derive total from prompt + completion when the body doesn't carry one (Anthropic).
  if (
    result.totalTokens === undefined &&
    result.promptTokens !== undefined &&
    result.completionTokens !== undefined
  ) {
    result.totalTokens = result.promptTokens + result.completionTokens;
  }

  return result;
}
