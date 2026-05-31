import type { ToolCallResult } from '../protocol';
import {
  buildTimeRangeNs,
  jsonReplacer,
  noApiKeysError,
  stripNulls,
  DEFAULT_TRACE_SUMMARY_LIMIT,
  MAX_TRACE_SUMMARY_LIMIT,
} from './shared';
import { queryPipe, type ToolCtx } from '../tinybird';

interface TraceSummaryRow {
  trace_id: string;
  timestamp: string;
  latest_received_at: string;
  capture_lag_ms: number;
  duration_ms: number;
  status: string;
  span_count: number;
  models: string[];
  operations: string[];
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  max_ttft_ms: number;
  total_cost_usd: number;
  total_count: number;
}

interface ListTraceSummariesParams {
  provider?: string;
  model?: string;
  status?: string;
  operation?: string;
  trace_id?: string;
  limit?: number;
  cursor?: string;
  hours?: number;
  sort_by?: string;
  order?: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const strings = value.filter(isNonEmptyString);
  return strings.length > 0 ? strings : undefined;
}

function formatTraceSummaryRow(row: TraceSummaryRow) {
  const tokens: Record<string, number> = {};
  if (row.prompt_tokens > 0) tokens.prompt = row.prompt_tokens;
  if (row.completion_tokens > 0) tokens.completion = row.completion_tokens;
  if (row.total_tokens > 0) tokens.total = row.total_tokens;

  return {
    trace_id: row.trace_id,
    timestamp: row.timestamp,
    latest_received_at: row.latest_received_at,
    capture_lag_ms: row.capture_lag_ms > 0 ? row.capture_lag_ms : undefined,
    duration_ms: row.duration_ms,
    status: row.status,
    span_count: row.span_count,
    models: normalizeStringArray(row.models),
    operations: normalizeStringArray(row.operations),
    tokens: Object.keys(tokens).length > 0 ? tokens : undefined,
    max_ttft_ms: row.max_ttft_ms > 0 ? row.max_ttft_ms : undefined,
    cost_usd: row.total_cost_usd > 0 ? row.total_cost_usd : undefined,
  };
}

export async function listTraceSummaries(
  ctx: ToolCtx,
  apiKeyIds: string[],
  params: ListTraceSummariesParams,
  retentionDays: number,
): Promise<ToolCallResult> {
  if (apiKeyIds.length === 0) {
    return noApiKeysError();
  }

  const token = await ctx.mintToken(
    [{ type: 'PIPES:READ', resource: 'mcp_trace_summaries' }],
    apiKeyIds,
    retentionDays,
  );

  const limit = Math.max(
    1,
    Math.min(params.limit ?? DEFAULT_TRACE_SUMMARY_LIMIT, MAX_TRACE_SUMMARY_LIMIT),
  );
  const parsedOffset = params.cursor ? Number.parseInt(params.cursor, 10) : 0;
  const offset = Number.isFinite(parsedOffset) ? Math.max(0, parsedOffset) : 0;
  const { startTimeNs } = buildTimeRangeNs(params.hours);

  const pipeParams: Record<string, string | number | undefined> = {
    start_time_ns: startTimeNs,
    limit,
    offset,
  };

  if (params.provider) pipeParams.provider = params.provider;
  if (params.model) pipeParams.model = params.model;
  if (params.status) pipeParams.status = params.status;
  if (params.operation) pipeParams.operation = params.operation;
  if (params.trace_id) pipeParams.trace_id = params.trace_id;
  if (params.sort_by) pipeParams.sort_by = params.sort_by;
  if (params.order) pipeParams.order = params.order;

  const data = await queryPipe(ctx.tinybirdBaseUrl, token, 'mcp_trace_summaries', pipeParams);
  const rows = data as unknown as TraceSummaryRow[];
  const totalCount = rows.length > 0 ? rows[0]!.total_count : 0;
  const hasMore = totalCount > offset + rows.length;

  const result = {
    traces: rows.map(formatTraceSummaryRow),
    pagination: {
      has_more: hasMore,
      next_cursor: hasMore ? String(offset + rows.length) : undefined,
      limit,
    },
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(stripNulls(result), jsonReplacer) }],
  };
}
