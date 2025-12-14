import { internalAction } from '../../_generated/server';
import { v } from 'convex/values';
import type { ToolCallResult } from '../protocol';
import {
  jsonReplacer,
  stripNulls,
  queryTinybirdPipe,
  noApiKeysError,
  generateTinybirdToken,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  DEFAULT_HOURS,
  MAX_HOURS,
} from './shared';

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

export const listTraces = internalAction({
  args: {
    apiKeys: v.array(v.string()),
    params: v.object({
      provider: v.optional(v.string()),
      model: v.optional(v.string()),
      status: v.optional(v.string()),
      limit: v.optional(v.number()),
      hours: v.optional(v.number()),
      cursor: v.optional(v.string()),
      sort_by: v.optional(v.string()),
      order: v.optional(v.string()),
    }),
  },
  handler: async (_, args): Promise<ToolCallResult> => {
    const { apiKeys, params } = args;

    if (apiKeys.length === 0) {
      return noApiKeysError();
    }

    const token = await generateTinybirdToken(
      [{ type: 'PIPES:READ', resource: 'mcp_traces_list' }],
      apiKeys,
    );

    const limit = Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const hours = Math.min(params.hours ?? DEFAULT_HOURS, MAX_HOURS);
    const offset = params.cursor ? parseInt(params.cursor, 10) || 0 : 0;
    const startTimeNs = (Date.now() - hours * 60 * 60 * 1000) * 1_000_000;

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

    const data = await queryTinybirdPipe(token, 'mcp_traces_list', pipeParams);

    const totalCount = data.length > 0 ? (data[0] as unknown as TraceRow).total_count : 0;
    const hasMore = totalCount > offset + data.length;
    const formattedTraces = data.map((row) => formatTraceRow(row as unknown as TraceRow));
    const nextCursor = hasMore ? String(offset + limit) : undefined;

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
  },
});
