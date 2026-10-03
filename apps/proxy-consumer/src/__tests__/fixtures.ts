import type { TinybirdTrace } from '@trace-flow/types';
import {
  createSpan,
  GEN_AI,
  GEN_AI_USAGE,
  CLI_PROXY,
  SOURCE_IMPORTED_EXECUTION,
  TRACE_FLOW,
  SPAN_KIND,
  SPAN_NAMES,
  type SpanBase,
} from '@trace-flow/otel-conventions';

const FIXTURE_BASE: SpanBase = {
  traceId: 'placeholder',
  receivedAt: 1700000000000000000,
  apiKey: 'test-key',
  tierAtIngestion: 'hobby',
  retentionExpiresAt: 1700604800000000000,
  serviceName: 'llm-observability',
};

export function createMockTrace(traceId: string): TinybirdTrace {
  return createSpan(
    { ...FIXTURE_BASE, traceId },
    {
      spanId: 'span-123',
      spanName: SPAN_NAMES.rootFor('chat', 'gpt-4'),
      spanKind: SPAN_KIND.CLIENT,
      parentSpanId: '',
      timestampMs: 1, // → 1_000_000 ns
      durationMs: 0.5, // → 500_000 ns
      attributes: {
        [GEN_AI.REQUEST_ID]: traceId,
        [GEN_AI.SYSTEM]: 'openai',
        [GEN_AI.REQUEST_MODEL]: 'gpt-4',
      },
    },
  );
}

export function createImportedMockTrace(
  identity: string,
  hash: string,
  requestId = 'same-inbound',
): TinybirdTrace {
  const trace = createMockTrace('imported-trace');
  trace.SpanAttributes = {
    ...trace.SpanAttributes,
    [TRACE_FLOW.SOURCE]: SOURCE_IMPORTED_EXECUTION,
    [TRACE_FLOW.IMPORT_IDENTITY]: identity,
    [TRACE_FLOW.IMPORT_SOURCE_HASH]: hash,
    [CLI_PROXY.INBOUND_REQUEST_ID]: requestId,
    [GEN_AI_USAGE.MISSING]: 'true',
  };
  return trace;
}
