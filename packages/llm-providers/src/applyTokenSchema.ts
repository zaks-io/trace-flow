import type { LLMTokenUsage } from '@trace-flow/types';
import type { ProviderTokenSchema } from './types';

/**
 * Pre-normalization shape produced by both `parseTokenUsage` (whole-body regex)
 * and `createTokenAccumulator` (streaming events). Field names are canonical
 * Trace Flow names; each caller's job is to translate upstream names
 * (`input_tokens` vs `prompt_tokens` vs `promptTokenCount`) into this shape.
 *
 * `undefined` means "never observed"; `0` means "observed and zero." The two are
 * different — `applyTokenSchema` preserves zero values that originate from the
 * provider while still treating absence as absence.
 */
export interface RawTokenTotals {
  inputTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  cacheCreation5mTokens?: number;
  cacheCreation1hTokens?: number;
  /** Provider-reported total. When present, used as-is (Google's cumulative
   *  last-wins or whole-body `total_tokens`). Otherwise the total is derived
   *  from prompt + completion. */
  explicitTotal?: number;
  /** Anthropic thinking-block characters when `reasoning_tokens` isn't reported.
   *  Converted at ~4 chars/token only when no explicit reasoning value is present. */
  thinkingChars?: number;
  upstreamCost?: number;
}

/**
 * Apply provider-specific normalization rules to raw totals. Single source of truth
 * for the `promptIncludesCache` split, cache-creation aggregation, total derivation,
 * and reasoning-token fallback. Both whole-body and streaming paths call this so
 * the canonical `LLMTokenUsage` shape can't drift between them.
 */
export function applyTokenSchema(
  raw: RawTokenTotals,
  schema: ProviderTokenSchema,
): LLMTokenUsage | undefined {
  const hasSignal =
    raw.inputTokens !== undefined ||
    raw.completionTokens !== undefined ||
    raw.explicitTotal !== undefined ||
    raw.upstreamCost !== undefined ||
    (raw.thinkingChars !== undefined && raw.thinkingChars > 0);
  if (!hasSignal) return undefined;

  let cacheCreation = raw.cacheCreationTokens;
  if (
    cacheCreation === undefined &&
    schema.nestedCacheCreation &&
    (raw.cacheCreation5mTokens !== undefined || raw.cacheCreation1hTokens !== undefined)
  ) {
    cacheCreation = (raw.cacheCreation5mTokens ?? 0) + (raw.cacheCreation1hTokens ?? 0);
  }
  const cacheRead = raw.cacheReadTokens;

  const result: LLMTokenUsage = {};

  if (raw.inputTokens !== undefined) {
    if (schema.promptIncludesCache) {
      result.promptTokens = raw.inputTokens;
      result.uncachedInputTokens = Math.max(
        0,
        raw.inputTokens - (cacheRead ?? 0) - (cacheCreation ?? 0),
      );
    } else {
      result.promptTokens = raw.inputTokens + (cacheRead ?? 0) + (cacheCreation ?? 0);
      result.uncachedInputTokens = raw.inputTokens;
    }
  }

  if (raw.completionTokens !== undefined) result.completionTokens = raw.completionTokens;
  if (cacheRead !== undefined) result.cacheReadTokens = cacheRead;
  if (cacheCreation !== undefined) result.cacheCreationTokens = cacheCreation;
  if (raw.cacheCreation5mTokens !== undefined)
    result.cacheCreation5mTokens = raw.cacheCreation5mTokens;
  if (raw.cacheCreation1hTokens !== undefined)
    result.cacheCreation1hTokens = raw.cacheCreation1hTokens;

  if (raw.reasoningTokens !== undefined) {
    result.reasoningTokens = raw.reasoningTokens;
  } else if (raw.thinkingChars !== undefined && raw.thinkingChars > 0) {
    result.reasoningTokens = Math.ceil(raw.thinkingChars / 4);
  }

  if (raw.upstreamCost !== undefined) result.upstreamCost = raw.upstreamCost;

  if (raw.explicitTotal !== undefined) {
    result.totalTokens = raw.explicitTotal;
  } else if (result.promptTokens !== undefined && result.completionTokens !== undefined) {
    result.totalTokens = result.promptTokens + result.completionTokens;
  }

  return result;
}
