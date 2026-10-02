import {
  GEN_AI_USAGE,
  IMPORTED_EXECUTION,
  IMPORTED_USAGE_QUALITY,
} from '@trace-flow/otel-conventions';

const COUNT_KEYS = [
  GEN_AI_USAGE.TOTAL_TOKENS,
  GEN_AI_USAGE.INPUT_TOKENS,
  GEN_AI_USAGE.INPUT_TOKENS_UNCACHED,
  GEN_AI_USAGE.CACHE_READ_INPUT_TOKENS,
  GEN_AI_USAGE.CACHE_CREATION_INPUT_TOKENS,
  GEN_AI_USAGE.OUTPUT_TOKENS,
  GEN_AI_USAGE.OUTPUT_TOKENS_NON_REASONING,
  GEN_AI_USAGE.REASONING_TOKENS,
  GEN_AI_USAGE.UNCLASSIFIED_TOKENS,
] as const;

export function validateImportedTokenUsage(attributes: Record<string, string>): string | undefined {
  if (attributes[GEN_AI_USAGE.MISSING] !== undefined) {
    if (attributes[GEN_AI_USAGE.MISSING] !== 'true') return 'usage_missing_value';
    if (
      attributes[GEN_AI_USAGE.SCHEMA_VERSION] !== undefined ||
      attributes[GEN_AI_USAGE.QUALITY] !== undefined ||
      COUNT_KEYS.some((key) => attributes[key] !== undefined)
    ) {
      return 'usage_missing_mixed';
    }
    return undefined;
  }

  if (attributes[GEN_AI_USAGE.SCHEMA_VERSION] !== '2') return 'usage_schema_version';
  const quality = attributes[GEN_AI_USAGE.QUALITY];
  if (!IMPORTED_USAGE_QUALITY.some((value) => value === quality)) return 'usage_quality';

  const counts = new Map<string, number>();
  for (const key of COUNT_KEYS) {
    const value = attributes[key];
    if (value === undefined || !/^(0|[1-9][0-9]*)$/.test(value)) return 'usage_count_missing';
    const count = Number(value);
    if (!Number.isSafeInteger(count) || count > IMPORTED_EXECUTION.MAX_TOTAL_TOKENS) {
      return 'usage_count_range';
    }
    counts.set(key, count);
  }
  const count = (key: string) => counts.get(key)!;
  if (
    count(GEN_AI_USAGE.INPUT_TOKENS) !==
    count(GEN_AI_USAGE.INPUT_TOKENS_UNCACHED) +
      count(GEN_AI_USAGE.CACHE_READ_INPUT_TOKENS) +
      count(GEN_AI_USAGE.CACHE_CREATION_INPUT_TOKENS)
  ) {
    return 'usage_input_invariant';
  }
  if (
    count(GEN_AI_USAGE.OUTPUT_TOKENS) !==
    count(GEN_AI_USAGE.OUTPUT_TOKENS_NON_REASONING) + count(GEN_AI_USAGE.REASONING_TOKENS)
  ) {
    return 'usage_output_invariant';
  }
  if (
    count(GEN_AI_USAGE.TOTAL_TOKENS) !==
    count(GEN_AI_USAGE.INPUT_TOKENS) +
      count(GEN_AI_USAGE.OUTPUT_TOKENS) +
      count(GEN_AI_USAGE.UNCLASSIFIED_TOKENS)
  ) {
    return 'usage_total_invariant';
  }
  if (quality === 'complete' && count(GEN_AI_USAGE.UNCLASSIFIED_TOKENS) !== 0) {
    return 'usage_complete_unclassified';
  }
  return undefined;
}
