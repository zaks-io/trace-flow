/** SQL building has been moved to Tinybird Pipes for security. */
import {
  BAGGAGE_PREFIX,
  GEN_AI,
  GEN_AI_COST,
  GEN_AI_USAGE,
  HTTP,
  STATUS_CODE,
} from '@trace-flow/otel-conventions';

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
}

export interface ParsedSpan {
  span_id: string;
  parent_span_id: string | undefined;
  name: string;
  timestamp: string | undefined;
  duration_ms: number;
  status: string;
  status_message: string | undefined;
  provider: string | undefined;
  model: string | undefined;
  target_url: string | undefined;
  http_status: string | undefined;
  tokens: Record<string, number> | undefined;
  cost_usd: Record<string, number> | undefined;
  time_to_first_token_ms: number | undefined;
  baggage: Record<string, string> | undefined;
  operation: string | undefined;
}

function parseSpanAttributes(spanAttributes: unknown): Record<string, unknown> {
  if (typeof spanAttributes === 'string') {
    try {
      return JSON.parse(spanAttributes) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return (spanAttributes as Record<string, unknown>) ?? {};
}

function parseTimestampIso(timestampNs: unknown): string | undefined {
  const timestamp = Number(timestampNs);
  if (!Number.isFinite(timestamp)) {
    return undefined;
  }

  const date = new Date(timestamp / 1_000_000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function parseDurationMs(durationNs: unknown): number {
  const duration = Number(durationNs);
  return Number.isFinite(duration) ? duration / 1_000_000 : 0;
}

function extractBaggage(attrs: Record<string, unknown>): Record<string, string> | undefined {
  const baggage: Record<string, string> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith(BAGGAGE_PREFIX) && value != null) {
      const strValue =
        typeof value === 'string'
          ? value
          : typeof value === 'number' || typeof value === 'boolean'
            ? String(value)
            : JSON.stringify(value);
      baggage[key.slice(BAGGAGE_PREFIX.length)] = strValue;
    }
  }
  return Object.keys(baggage).length > 0 ? baggage : undefined;
}

export function parseSpanRow(row: SpanRow): ParsedSpan {
  const attrs = parseSpanAttributes(row.SpanAttributes);

  const promptTokens = Number(attrs[GEN_AI_USAGE.INPUT_TOKENS]) || 0;
  const completionTokens = Number(attrs[GEN_AI_USAGE.OUTPUT_TOKENS]) || 0;
  const totalTokens = promptTokens + completionTokens;
  const cachedTokens = Number(attrs[GEN_AI_USAGE.CACHE_READ_INPUT_TOKENS]) || 0;
  const reasoningTokens = Number(attrs[GEN_AI_USAGE.REASONING_TOKENS]) || 0;

  const inputCost = Number(attrs[GEN_AI_COST.INPUT]) || 0;
  const outputCost = Number(attrs[GEN_AI_COST.OUTPUT]) || 0;
  const totalCost = Number(attrs[GEN_AI_COST.TOTAL]) || 0;

  const tokens: Record<string, number> = {};
  if (promptTokens > 0) tokens.prompt = promptTokens;
  if (completionTokens > 0) tokens.completion = completionTokens;
  if (totalTokens > 0) tokens.total = totalTokens;
  if (cachedTokens > 0) tokens.cached = cachedTokens;
  if (reasoningTokens > 0) tokens.reasoning = reasoningTokens;

  const costUsd: Record<string, number> = {};
  if (inputCost > 0) costUsd.input = inputCost;
  if (outputCost > 0) costUsd.output = outputCost;
  if (totalCost > 0) costUsd.total = totalCost;

  return {
    span_id: row.SpanId as string,
    parent_span_id: row.ParentSpanId as string | undefined,
    name: row.SpanName as string,
    timestamp: parseTimestampIso(row.Timestamp),
    duration_ms: parseDurationMs(row.Duration),
    status: row.StatusCode === STATUS_CODE.OK ? 'ok' : 'error',
    status_message: row.StatusMessage as string | undefined,
    provider: attrs[GEN_AI.SYSTEM] as string | undefined,
    model: attrs[GEN_AI.REQUEST_MODEL] as string | undefined,
    target_url: attrs[HTTP.URL] as string | undefined,
    http_status: attrs[HTTP.RESPONSE_STATUS_CODE] as string | undefined,
    tokens: Object.keys(tokens).length > 0 ? tokens : undefined,
    cost_usd: Object.keys(costUsd).length > 0 ? costUsd : undefined,
    time_to_first_token_ms: Number(attrs[GEN_AI.SERVER_TTFT]) || undefined,
    baggage: extractBaggage(attrs),
    operation: attrs[GEN_AI.OPERATION_NAME] as string | undefined,
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
  if (expand.has('operation') && span.operation) output.operation = span.operation;

  return output;
}
