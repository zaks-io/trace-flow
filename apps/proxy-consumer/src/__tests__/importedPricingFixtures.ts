import fixture from '../../../../fixtures/cliproxyapi-execution-v2.json';
import type { TinybirdTrace } from '@trace-flow/types';
import { GEN_AI, GEN_AI_USAGE } from '@trace-flow/otel-conventions';
import { createImportedMockTrace } from './fixtures';

export function importedPricingTrace(
  identity: string,
  provider: string,
  model: string,
  buckets: {
    input: number;
    read: number;
    write: number;
    output: number;
    reasoning: number;
    unclassified?: number;
  },
): TinybirdTrace {
  const span = fixture.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
  const trace = createImportedMockTrace(identity.repeat(64), 'a'.repeat(64));
  const attributes: Record<string, string> = Object.fromEntries(
    span.attributes.map(({ key, value }) => [
      key,
      String(
        'stringValue' in value
          ? value.stringValue
          : 'intValue' in value
            ? value.intValue
            : value.boolValue,
      ),
    ]),
  );
  const unclassified = buckets.unclassified ?? 0;
  trace.SpanAttributes = {
    ...attributes,
    ...trace.SpanAttributes,
    [GEN_AI.SYSTEM]: provider,
    [GEN_AI.REQUEST_MODEL]: 'requested-alias',
    [GEN_AI.RESPONSE_MODEL]: model,
    [GEN_AI_USAGE.INPUT_TOKENS_UNCACHED]: String(buckets.input),
    [GEN_AI_USAGE.CACHE_READ_INPUT_TOKENS]: String(buckets.read),
    [GEN_AI_USAGE.CACHE_CREATION_INPUT_TOKENS]: String(buckets.write),
    [GEN_AI_USAGE.INPUT_TOKENS]: String(buckets.input + buckets.read + buckets.write),
    [GEN_AI_USAGE.OUTPUT_TOKENS]: String(buckets.output + buckets.reasoning),
    [GEN_AI_USAGE.OUTPUT_TOKENS_NON_REASONING]: String(buckets.output),
    [GEN_AI_USAGE.REASONING_TOKENS]: String(buckets.reasoning),
    [GEN_AI_USAGE.UNCLASSIFIED_TOKENS]: String(unclassified),
    [GEN_AI_USAGE.TOTAL_TOKENS]: String(
      buckets.input +
        buckets.read +
        buckets.write +
        buckets.output +
        buckets.reasoning +
        unclassified,
    ),
    [GEN_AI_USAGE.QUALITY]: unclassified ? 'unclassified' : 'complete',
  };
  delete trace.SpanAttributes[GEN_AI_USAGE.MISSING];
  return trace;
}
