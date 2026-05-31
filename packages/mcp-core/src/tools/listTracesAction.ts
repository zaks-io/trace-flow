import type { ToolCallResult } from '../protocol';
import {
  jsonReplacer,
  stripNulls,
  noApiKeysError,
  buildTimeRangeNs,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  DEFAULT_HOURS,
} from './shared';
import { queryPipe, type ToolCtx } from '../tinybird';

export interface TraceRow {
  trace_id: string;
  timestamp: string;
  duration_ms: number;
  status: string;
  provider: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_usd: number;
  total_count: number;
}

interface FormattedTrace {
  trace_id: string;
  timestamp: string;
  duration_ms: number;
  status: string;
  provider: string;
  model: string;
  tokens?: Record<string, number>;
  cost_usd?: number;
}

export function formatTraceRow(row: TraceRow): FormattedTrace {
  const tokens: Record<string, number> = {};
  if (row.prompt_tokens > 0) tokens.prompt = row.prompt_tokens;
  if (row.completion_tokens > 0) tokens.completion = row.completion_tokens;
  if (row.total_tokens > 0) tokens.total = row.total_tokens;

  return {
    trace_id: row.trace_id,
    timestamp: row.timestamp,
    duration_ms: row.duration_ms,
    status: row.status,
    provider: row.provider,
    model: row.model,
    tokens: Object.keys(tokens).length > 0 ? tokens : undefined,
    cost_usd: row.cost_usd > 0 ? row.cost_usd : undefined,
  };
}

interface ListTracesParams {
  provider?: string;
  model?: string;
  status?: string;
  limit?: number;
  hours?: number;
  cursor?: string;
  sort_by?: string;
  order?: string;
}

export async function listTraces(
  ctx: ToolCtx,
  apiKeyIds: string[],
  params: ListTracesParams,
  retentionDays: number,
): Promise<ToolCallResult> {
  if (apiKeyIds.length === 0) {
    return noApiKeysError();
  }

  const token = await ctx.mintToken(
    [{ type: 'PIPES:READ', resource: 'mcp_traces_list' }],
    apiKeyIds,
    retentionDays,
  );

  const limit = Math.max(1, Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
  const parsedOffset = params.cursor ? Number.parseInt(params.cursor, 10) : 0;
  const offset = Number.isFinite(parsedOffset) ? Math.max(0, parsedOffset) : 0;
  const { startTimeNs } = buildTimeRangeNs(params.hours, DEFAULT_HOURS, retentionDays * 24);

  const pipeParams: Record<string, string | number | undefined> = {
    start_time_ns: startTimeNs,
    limit,
    offset,
  };

  if (params.provider) pipeParams.provider = params.provider;
  if (params.model) pipeParams.model = params.model;
  if (params.status) pipeParams.status = params.status;
  if (params.sort_by) pipeParams.sort_by = params.sort_by;
  if (params.order) pipeParams.order = params.order;

  const data = await queryPipe(ctx.tinybirdBaseUrl, token, 'mcp_traces_list', pipeParams);

  const totalCount = data.length > 0 ? (data[0] as unknown as TraceRow).total_count : 0;
  const hasMore = totalCount > offset + data.length;
  const formattedTraces = data.map((row) => formatTraceRow(row as unknown as TraceRow));
  const nextCursor = hasMore ? String(offset + data.length) : undefined;

  const result = {
    traces: formattedTraces,
    pagination: {
      has_more: hasMore,
      next_cursor: nextCursor,
      limit,
    },
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(stripNulls(result), jsonReplacer) }],
  };
}
