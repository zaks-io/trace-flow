import { visit } from 'jsonc-parser';
import type { LLMResponseMetadataSummary, LLMTokenUsage } from '@trace-flow/types';
import { boundedSSEMetadataValue } from './sse-state';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Duplicate accounting fields are ambiguous even when JSON.parse accepts them. */
function parseBody(body: string): Record<string, unknown> | undefined {
  let invalid = false;
  const rootKeys = new Set<string>();
  const usageKeys = new Set<string>();
  visit(
    body,
    {
      onObjectProperty(property, _offset, _length, _line, _character, pathSupplier) {
        const path = pathSupplier();
        const keys =
          path.length === 0
            ? rootKeys
            : path.length === 1 && path[0] === 'usage'
              ? usageKeys
              : undefined;
        if (!keys) return;
        if (keys.has(property)) invalid = true;
        keys.add(property);
      },
      onError() {
        invalid = true;
      },
    },
    { disallowComments: true, allowTrailingComma: false },
  );
  if (invalid) return undefined;
  try {
    return record(JSON.parse(body));
  } catch {
    return undefined;
  }
}

function boundedString(value: unknown): string | undefined {
  return typeof value === 'string' ? boundedSSEMetadataValue(value) : undefined;
}

export function parseRequestModel(body: string): string | undefined {
  return boundedString(parseBody(body)?.model);
}

export function parseDecisionMetadata(body: string): LLMResponseMetadataSummary | undefined {
  const parsed = parseBody(body);
  if (!parsed) return undefined;
  const model = boundedString(parsed.model);
  const id = boundedString(parsed.id);
  return model || id ? { ...(model ? { model } : {}), ...(id ? { id } : {}) } : undefined;
}

export function parseDecisionTokenUsage(
  body: string,
  includeCost = false,
): LLMTokenUsage | undefined {
  const usage = record(parseBody(body)?.usage);
  if (!usage) return undefined;
  for (const field of ['input_tokens', 'output_tokens'] as const) {
    const value = usage[field];
    if (
      value !== undefined &&
      (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    ) {
      return undefined;
    }
  }
  const cost = includeCost ? usage.cost : undefined;
  if (cost !== undefined && (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0)) {
    return undefined;
  }
  const input = usage.input_tokens as number | undefined;
  const output = usage.output_tokens as number | undefined;
  if (input === undefined && output === undefined && cost === undefined) return undefined;
  const tokens: LLMTokenUsage = {};
  if (input !== undefined) {
    tokens.promptTokens = input;
    tokens.uncachedInputTokens = input;
  }
  if (output !== undefined) tokens.completionTokens = output;
  if (input !== undefined && output !== undefined) {
    if (!Number.isSafeInteger(input + output)) return undefined;
    tokens.totalTokens = input + output;
  }
  if (cost !== undefined) tokens.upstreamCost = cost;
  return tokens;
}
