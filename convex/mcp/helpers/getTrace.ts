/**
 * Helper functions for parsing and formatting trace spans.
 * SQL building has been moved to Tinybird Pipes for security.
 */

export interface SpanRow {
  ReceivedAt: unknown;
  Timestamp: unknown;
  TraceId: unknown;
  SpanId: unknown;
  ParentSpanId: unknown;
  SpanName: unknown;
  Duration: unknown;
  StatusCode: unknown;
  StatusMessage: unknown;
  SpanAttributes: unknown;
  EventTimestamps: unknown;
  EventNames: unknown;
  EventAttributes: unknown;
}

export interface ParsedEvent {
  name: string;
  timestamp: string;
  attributes: Record<string, string>;
}

export interface ParsedSpan {
  span_id: string;
  parent_span_id: string | undefined;
  name: string;
  timestamp: string;
  duration_ms: number;
  status: string;
  status_message: string | undefined;
  provider: string | undefined;
  model: string | undefined;
  target_url: string | undefined;
  http_status: string | undefined;
  tokens:
    | {
        prompt: number;
        completion: number;
        total: number;
        cached: number;
        reasoning: number;
      }
    | undefined;
  cost_usd:
    | {
        input: number;
        output: number;
        total: number;
      }
    | undefined;
  time_to_first_token_ms: number | undefined;
  baggage: Record<string, string> | undefined;
  events: ParsedEvent[] | undefined;
}

function parseSpanAttributes(spanAttributes: unknown): Record<string, unknown> {
  if (typeof spanAttributes === 'string') {
    return JSON.parse(spanAttributes) as Record<string, unknown>;
  }
  return (spanAttributes as Record<string, unknown>) ?? {};
}

function extractBaggage(attrs: Record<string, unknown>): Record<string, string> | undefined {
  const baggage: Record<string, string> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith('baggage.') && value != null) {
      const strValue =
        typeof value === 'string'
          ? value
          : typeof value === 'number' || typeof value === 'boolean'
            ? String(value)
            : JSON.stringify(value);
      baggage[key.slice(8)] = strValue;
    }
  }
  return Object.keys(baggage).length > 0 ? baggage : undefined;
}

export function parseEvents(
  timestamps: unknown,
  names: unknown,
  attributes: unknown,
): ParsedEvent[] | undefined {
  if (!Array.isArray(names) || names.length === 0) {
    return undefined;
  }

  const tsArray = Array.isArray(timestamps) ? timestamps : [];
  const attrArray = Array.isArray(attributes) ? attributes : [];

  const events: ParsedEvent[] = [];
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    if (typeof name !== 'string') continue;

    const tsNanos = typeof tsArray[i] === 'bigint' ? Number(tsArray[i]) : Number(tsArray[i] ?? 0);
    const timestamp = new Date(tsNanos / 1_000_000).toISOString();

    let attrs: Record<string, string> = {};
    const rawAttr = attrArray[i];
    if (typeof rawAttr === 'string') {
      try {
        attrs = JSON.parse(rawAttr) as Record<string, string>;
      } catch {
        attrs = {};
      }
    } else if (rawAttr && typeof rawAttr === 'object') {
      attrs = rawAttr as Record<string, string>;
    }

    events.push({ name, timestamp, attributes: attrs });
  }

  return events.length > 0 ? events : undefined;
}

export function parseSpanRow(row: SpanRow): ParsedSpan {
  const attrs = parseSpanAttributes(row.SpanAttributes);

  const promptTokens = Number(attrs['ai.tokens.prompt']) || 0;
  const completionTokens = Number(attrs['ai.tokens.completion']) || 0;
  const totalTokens = Number(attrs['ai.tokens.total']) || 0;
  const cachedTokens = Number(attrs['ai.tokens.cached']) || 0;
  const reasoningTokens = Number(attrs['ai.tokens.reasoning']) || 0;

  const inputCost = Number(attrs['ai.cost.input']) || 0;
  const outputCost = Number(attrs['ai.cost.output']) || 0;
  const totalCost = Number(attrs['ai.cost.total']) || 0;

  return {
    span_id: row.SpanId as string,
    parent_span_id: row.ParentSpanId as string | undefined,
    name: row.SpanName as string,
    timestamp: new Date(Number(row.Timestamp) / 1_000_000).toISOString(),
    duration_ms: Number(row.Duration) / 1_000_000,
    status: row.StatusCode === 'STATUS_CODE_OK' ? 'ok' : 'error',
    status_message: row.StatusMessage as string | undefined,
    provider: attrs['ai.provider'] as string | undefined,
    model: attrs['ai.model'] as string | undefined,
    target_url: attrs['ai.target_url'] as string | undefined,
    http_status: attrs['http.status_code'] as string | undefined,
    tokens:
      totalTokens > 0 || promptTokens > 0 || completionTokens > 0
        ? {
            prompt: promptTokens,
            completion: completionTokens,
            total: totalTokens,
            cached: cachedTokens,
            reasoning: reasoningTokens,
          }
        : undefined,
    cost_usd:
      totalCost > 0 || inputCost > 0 || outputCost > 0
        ? { input: inputCost, output: outputCost, total: totalCost }
        : undefined,
    time_to_first_token_ms: Number(attrs['ai.time_to_first_token_ms']) || undefined,
    baggage: extractBaggage(attrs),
    events: parseEvents(row.EventTimestamps, row.EventNames, row.EventAttributes),
  };
}

export function buildOutputSpan(span: ParsedSpan, expand: Set<string>): Record<string, unknown> {
  const output: Record<string, unknown> = {
    span_id: span.span_id,
    name: span.name,
    duration_ms: span.duration_ms,
    status: span.status,
    timestamp: span.timestamp,
  };

  if (expand.has('parent') && span.parent_span_id) output.parent_span_id = span.parent_span_id;
  if (expand.has('status_message') && span.status_message)
    output.status_message = span.status_message;
  if (expand.has('provider') && span.provider) output.provider = span.provider;
  if (expand.has('model') && span.model) output.model = span.model;
  if (expand.has('url') && span.target_url) output.target_url = span.target_url;
  if (expand.has('http') && span.http_status) output.http_status = span.http_status;
  if (expand.has('tokens') && span.tokens) output.tokens = span.tokens;
  if (expand.has('costs') && span.cost_usd) output.cost_usd = span.cost_usd;
  if (expand.has('ttft') && span.time_to_first_token_ms)
    output.time_to_first_token_ms = span.time_to_first_token_ms;
  if (expand.has('baggage') && span.baggage) output.baggage = span.baggage;
  if (expand.has('events') && span.events) output.events = span.events;

  return output;
}
