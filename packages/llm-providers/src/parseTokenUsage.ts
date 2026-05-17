import type { LLMTokenUsage } from '@trace-flow/types';
import { PROVIDER_SCHEMAS } from './schemas';
import type { ProviderId, ProviderTokenSchema } from './types';
import { applyTokenSchema, type RawTokenTotals } from './applyTokenSchema';

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

function extractRawTotals(body: string, schema: ProviderTokenSchema): RawTokenTotals {
  const raw: RawTokenTotals = {};

  const inputTokens = firstIntMatch(body, schema.promptFields, schema.lastMatchOnly);
  if (inputTokens !== undefined) raw.inputTokens = inputTokens;

  const completionTokens = firstIntMatch(body, schema.completionFields, schema.lastMatchOnly);
  if (completionTokens !== undefined) raw.completionTokens = completionTokens;

  if (schema.totalFields) {
    const total = firstIntMatch(body, schema.totalFields, schema.lastMatchOnly);
    if (total !== undefined) raw.explicitTotal = total;
  }

  if (schema.cacheReadFields) {
    const cacheRead = firstIntMatch(body, schema.cacheReadFields, schema.lastMatchOnly);
    if (cacheRead !== undefined) raw.cacheReadTokens = cacheRead;
  }

  if (schema.cacheCreationFields) {
    const cacheCreation = firstIntMatch(body, schema.cacheCreationFields, schema.lastMatchOnly);
    if (cacheCreation !== undefined) raw.cacheCreationTokens = cacheCreation;
  }

  if (schema.reasoningFields) {
    const reasoning = firstIntMatch(body, schema.reasoningFields, schema.lastMatchOnly);
    if (reasoning !== undefined) raw.reasoningTokens = reasoning;
  }

  if (schema.nestedCacheCreation) {
    const m5 = matchIntField(body, schema.nestedCacheCreation.field5m, false);
    if (m5 !== undefined) raw.cacheCreation5mTokens = m5;
    const m1h = matchIntField(body, schema.nestedCacheCreation.field1h, false);
    if (m1h !== undefined) raw.cacheCreation1hTokens = m1h;
  }

  if (schema.hasUpstreamCost) {
    const cost = findUpstreamCost(body);
    if (cost !== undefined) raw.upstreamCost = cost;
  }

  return raw;
}

/**
 * Schema-driven whole-body token extraction. Regex-extracts raw fields into a
 * `RawTokenTotals`, then defers to `applyTokenSchema` for canonical normalization
 * — the same normalizer the streaming accumulator uses, so the two paths can't drift.
 */
export function parseTokenUsage(body: string, providerId: ProviderId): LLMTokenUsage | undefined {
  const schema = PROVIDER_SCHEMAS[providerId];
  return parseTokenUsageWithSchema(body, schema);
}

export function parseTokenUsageWithSchema(
  body: string,
  schema: ProviderTokenSchema,
): LLMTokenUsage | undefined {
  return applyTokenSchema(extractRawTotals(body, schema), schema);
}
