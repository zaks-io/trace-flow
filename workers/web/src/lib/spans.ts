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
 */
export function parseSpanAttributes(attributesJson: string): Record<string, string> {
  try {
    return JSON.parse(attributesJson) as Record<string, string>;
  } catch {
    return {};
  }
}

/**
 * Checks if a span is an LLM request span (root span for an LLM call).
 * Supports both legacy 'ai.request' naming and new GenAI semantic conventions.
 */
export function isLLMRequestSpan(span: Pick<TraceSpan, 'SpanName' | 'SpanAttributes'>): boolean {
  if (span.SpanName === 'ai.request') return true;
  const attrs = parseSpanAttributes(span.SpanAttributes);
  return 'gen_ai.operation.name' in attrs;
}
