import type { ToolCallResult } from '../protocol';
import {
  buildTimeRangeNs,
  noApiKeysError,
  DEFAULT_TRACE_SUMMARY_LIMIT,
  MAX_TRACE_SUMMARY_LIMIT,
  addOptionalPipeParams,
  jsonToolResult,
  mintPipeReadToken,
  offsetPipeParams,
  offsetPaginationResult,
  resolveOffsetPagination,
  tokenSummary,
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
    tokens: tokenSummary(row.prompt_tokens, row.completion_tokens, row.total_tokens),
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

  const token = await mintPipeReadToken(ctx, apiKeyIds, retentionDays, 'mcp_trace_summaries');
  const pagination = resolveOffsetPagination(
    params.limit,
    params.cursor,
    DEFAULT_TRACE_SUMMARY_LIMIT,
    MAX_TRACE_SUMMARY_LIMIT,
  );
  const { startTimeNs } = buildTimeRangeNs(params.hours);

  const pipeParams = offsetPipeParams(startTimeNs, pagination);
  addOptionalPipeParams(pipeParams, params, [
    'provider',
    'model',
    'status',
    'operation',
    'trace_id',
    'sort_by',
    'order',
  ]);

  const data = await queryPipe(ctx.tinybirdBaseUrl, token, 'mcp_trace_summaries', pipeParams);
  const rows = data as unknown as TraceSummaryRow[];
  const totalCount = rows.length > 0 ? rows[0]!.total_count : 0;

  const result = {
    traces: rows.map(formatTraceSummaryRow),
    pagination: offsetPaginationResult(pagination, rows.length, totalCount, { includeLimit: true }),
  };

  return jsonToolResult(result);
}
