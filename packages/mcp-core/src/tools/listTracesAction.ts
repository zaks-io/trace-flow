import type { ToolCallResult } from '../protocol';
import {
  noApiKeysError,
  buildTimeRangeNs,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  DEFAULT_HOURS,
  addOptionalPipeParams,
  jsonToolResult,
  mintPipeReadToken,
  offsetPipeParams,
  offsetPaginationResult,
  resolveOffsetPagination,
  tokenSummary,
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
  return {
    trace_id: row.trace_id,
    timestamp: row.timestamp,
    duration_ms: row.duration_ms,
    status: row.status,
    provider: row.provider,
    model: row.model,
    tokens: tokenSummary(row.prompt_tokens, row.completion_tokens, row.total_tokens),
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

  const token = await mintPipeReadToken(ctx, apiKeyIds, retentionDays, 'mcp_traces_list');
  const pagination = resolveOffsetPagination(params.limit, params.cursor, DEFAULT_LIMIT, MAX_LIMIT);
  const { startTimeNs } = buildTimeRangeNs(params.hours, DEFAULT_HOURS, retentionDays * 24);

  const pipeParams = offsetPipeParams(startTimeNs, pagination);
  addOptionalPipeParams(pipeParams, params, ['provider', 'model', 'status', 'sort_by', 'order']);

  const data = await queryPipe(ctx.tinybirdBaseUrl, token, 'mcp_traces_list', pipeParams);

  const totalCount = data.length > 0 ? (data[0] as unknown as TraceRow).total_count : 0;
  const formattedTraces = data.map((row) => formatTraceRow(row as unknown as TraceRow));

  const result = {
    traces: formattedTraces,
    pagination: offsetPaginationResult(pagination, data.length, totalCount, { includeLimit: true }),
  };

  return jsonToolResult(result);
}
