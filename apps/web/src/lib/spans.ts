import { parseSpanAttributes } from '@trace-flow/utils';

export { parseSpanAttributes };

export interface TraceSpan {
  Timestamp: number;
  TraceId: string;
  SpanId: string;
  ParentSpanId: string;
  SpanName: string;
  ServiceName: string;
  Duration: number;
  StatusCode: string;
  StatusMessage?: string;
  SpanAttributes: string;
  ResourceAttributes?: string;
  'Events.Timestamp'?: number[];
  'Events.Name'?: string[];
  'Events.Attributes'?: string[];
}

/**
 * Checks if a span is a Trace Flow proxy LLM request span.
 * Uses the trace_flow.source attribute to identify spans created by the proxy.
 */
export function isLLMRequestSpan(span: Pick<TraceSpan, 'SpanName' | 'SpanAttributes'>): boolean {
  const attrs = parseSpanAttributes(span.SpanAttributes);
  return attrs['trace_flow.source'] === 'proxy';
}
