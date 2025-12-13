import { internalAction } from '../../_generated/server';
import { v } from 'convex/values';
import type { ToolCallResult } from '../protocol';
import {
  jsonReplacer,
  queryTinybirdPipe,
  noApiKeysError,
  generateTinybirdToken,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  DEFAULT_HOURS,
  MAX_HOURS,
} from './shared';

interface TraceRow {
  TraceId: string;
  ReceivedAt: number;
  duration_ms: number;
  StatusCode: string;
  provider: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_usd: number;
}

interface FormattedTrace {
  trace_id: string;
  timestamp: string;
  duration_ms: number;
  status: string;
  provider: string;
  model: string;
  tokens: {
    prompt: number;
    completion: number;
    total: number;
  };
  cost_usd: number;
}

function formatTraceRow(row: TraceRow): FormattedTrace {
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
    }),
  },
  handler: async (_, args): Promise<ToolCallResult> => {
    const { apiKeys, params } = args;

    if (apiKeys.length === 0) {
      return noApiKeysError();
    }

    // Generate token with Pipe access
    const token = await generateTinybirdToken(
      [{ type: 'PIPES:READ', resource: 'mcp_traces_list' }],
      apiKeys,
    );

    // Normalize parameters
    const limit = Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const hours = Math.min(params.hours ?? DEFAULT_HOURS, MAX_HOURS);
    const offset = params.cursor ? parseInt(params.cursor, 10) || 0 : 0;
    const startTimeNs = (Date.now() - hours * 60 * 60 * 1000) * 1_000_000;

    // Build pipe parameters
    const pipeParams: Record<string, string | number | undefined> = {
      start_time_ns: startTimeNs,
      limit,
      offset,
    };

    if (params.provider) pipeParams.provider = params.provider;
    if (params.model) pipeParams.model = params.model;
    if (params.status) pipeParams.status = params.status;

    // Fetch from pipe
    const data = await queryTinybirdPipe(token, 'mcp_traces_list', pipeParams);

    // Process results
    const hasMore = data.length > limit;
    const traces = hasMore ? data.slice(0, limit) : data;
    const formattedTraces = traces.map((row) => formatTraceRow(row as unknown as TraceRow));
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
      content: [{ type: 'text', text: JSON.stringify(result, jsonReplacer) }],
    };
  },
});
