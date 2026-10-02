import { SOURCE_IMPORTED_EXECUTION, SOURCE_PROXY, TRACE_FLOW } from '@trace-flow/otel-conventions';
import { parseSpanAttributes } from './parseSpanAttributes';
import type { TraceSpanRow } from './TraceSpanRow';

/**
 * Whether a span is an LLM execution root from the edge proxy or imported OTLP.
 */
export function isLLMRequestSpan(span: Pick<TraceSpanRow, 'SpanName' | 'SpanAttributes'>): boolean {
  const attrs = parseSpanAttributes(span.SpanAttributes);
  return (
    attrs[TRACE_FLOW.SOURCE] === SOURCE_PROXY ||
    attrs[TRACE_FLOW.SOURCE] === SOURCE_IMPORTED_EXECUTION
  );
}
