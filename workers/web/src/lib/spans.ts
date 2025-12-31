/**
 * Shared span utilities for working with trace spans.
 */

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
 * Safely parses span attributes JSON string into a record.
 * Handles both string (from database) and object (from Tinybird API) formats.
 */
export function parseSpanAttributes(attributesJson: string): Record<string, string> {
  try {
    return typeof attributesJson === 'string'
      ? (JSON.parse(attributesJson) as Record<string, string>)
      : (attributesJson as unknown as Record<string, string>);
  } catch {
    return {};
  }
}

/**
 * Checks if a span is a Trace Flow proxy LLM request span.
 * Uses the trace_flow.source attribute to identify spans created by the proxy.
 */
export function isLLMRequestSpan(span: Pick<TraceSpan, 'SpanName' | 'SpanAttributes'>): boolean {
  const attrs = parseSpanAttributes(span.SpanAttributes);
  return attrs['trace_flow.source'] === 'proxy';
}
