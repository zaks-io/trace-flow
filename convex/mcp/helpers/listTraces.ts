import { escapeSQL, buildApiKeyFilter } from '../utils';
import { DEFAULT_LIMIT, MAX_LIMIT, DEFAULT_HOURS, MAX_HOURS } from '../tools/shared';

export interface ListTracesParams {
  provider?: string;
  model?: string;
  status?: string;
  limit?: number;
  hours?: number;
  cursor?: string;
}

export interface TraceRow {
  TraceId: unknown;
  ReceivedAt: unknown;
  duration_ms: unknown;
  StatusCode: unknown;
  provider: unknown;
  model: unknown;
  prompt_tokens: unknown;
  completion_tokens: unknown;
  total_tokens: unknown;
  cost_usd: unknown;
}

export interface FormattedTrace {
  trace_id: unknown;
  timestamp: string;
  duration_ms: unknown;
  status: string;
  provider: unknown;
  model: unknown;
  tokens: {
    prompt: unknown;
    completion: unknown;
    total: unknown;
  };
  cost_usd: unknown;
}

export interface ListTracesResult {
  traces: FormattedTrace[];
  pagination: {
    has_more: boolean;
    next_cursor: string | undefined;
    limit: number;
  };
}

export function normalizeParams(params: ListTracesParams): {
  limit: number;
  hours: number;
  offset: number;
} {
  return {
    limit: Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT),
    hours: Math.min(params.hours ?? DEFAULT_HOURS, MAX_HOURS),
    offset: params.cursor ? parseInt(params.cursor, 10) || 0 : 0,
  };
}

export function buildListTracesConditions(
  apiKeys: string[],
  params: ListTracesParams,
  startTimeNs: number,
): string[] {
  const conditions: string[] = [
    "SpanName = 'ai.request'",
    buildApiKeyFilter(apiKeys),
    `ReceivedAt >= ${startTimeNs}`,
  ];

  if (params.provider) {
    conditions.push(
      `JSONExtractString(SpanAttributes, 'ai.provider') = '${escapeSQL(params.provider)}'`,
    );
  }
  if (params.model) {
    conditions.push(`JSONExtractString(SpanAttributes, 'ai.model') = '${escapeSQL(params.model)}'`);
  }
  if (params.status) {
    conditions.push(`StatusCode = '${escapeSQL(params.status)}'`);
  }

  return conditions;
}

export function buildListTracesSQL(conditions: string[], limit: number, offset: number): string {
  const offsetClause = offset > 0 ? `OFFSET ${offset}` : '';

  return `SELECT
      TraceId,
      ReceivedAt,
      Duration / 1000000 as duration_ms,
      StatusCode,
      JSONExtractString(SpanAttributes, 'ai.provider') as provider,
      JSONExtractString(SpanAttributes, 'ai.model') as model,
      JSONExtractInt(SpanAttributes, 'ai.tokens.prompt') as prompt_tokens,
      JSONExtractInt(SpanAttributes, 'ai.tokens.completion') as completion_tokens,
      JSONExtractInt(SpanAttributes, 'ai.tokens.total') as total_tokens,
      JSONExtractFloat(SpanAttributes, 'ai.cost.total') as cost_usd
    FROM otel_traces
    WHERE ${conditions.join(' AND ')}
    ORDER BY ReceivedAt DESC
    LIMIT ${limit + 1}
    ${offsetClause}
    FORMAT JSON`;
}

export function formatTraceRow(row: TraceRow): FormattedTrace {
  return {
    trace_id: row.TraceId,
    timestamp: new Date(Number(row.ReceivedAt) / 1_000_000).toISOString(),
    duration_ms: row.duration_ms,
    status: row.StatusCode === 'STATUS_CODE_OK' ? 'ok' : 'error',
    provider: row.provider,
    model: row.model,
    tokens: {
      prompt: row.prompt_tokens,
      completion: row.completion_tokens,
      total: row.total_tokens,
    },
    cost_usd: row.cost_usd,
  };
}

export function buildListTracesResult(
  data: Record<string, unknown>[],
  limit: number,
  currentOffset: number,
): ListTracesResult {
  const hasMore = data.length > limit;
  const traces = hasMore ? data.slice(0, limit) : data;
  const nextCursor = hasMore ? String(currentOffset + limit) : undefined;

  return {
    traces: traces.map((row) => formatTraceRow(row as unknown as TraceRow)),
    pagination: {
      has_more: hasMore,
      next_cursor: nextCursor,
      limit,
    },
  };
}
