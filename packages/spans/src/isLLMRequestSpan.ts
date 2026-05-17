import { SOURCE_PROXY, TRACE_FLOW } from '@trace-flow/otel-conventions';
import { parseSpanAttributes } from './parseSpanAttributes';
import type { TraceSpanRow } from './TraceSpanRow';

/**
 * Whether a span is a Trace Flow proxy LLM request span.
 * Identified by the `trace_flow.source = 'proxy'` attribute.
 */
export function isLLMRequestSpan(span: Pick<TraceSpanRow, 'SpanName' | 'SpanAttributes'>): boolean {
  const attrs = parseSpanAttributes(span.SpanAttributes);
  return attrs[TRACE_FLOW.SOURCE] === SOURCE_PROXY;
}
