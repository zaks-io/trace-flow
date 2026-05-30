import type { ToolCallResult } from '../protocol';
import {
  jsonReplacer,
  stripNulls,
  noApiKeysError,
  invalidTraceIdError,
  traceNotFoundError,
  TRACE_ID_PATTERN,
  DEFAULT_SPAN_LIMIT,
  MAX_SPAN_LIMIT,
  splitPatterns,
} from './shared';
import { queryPipe, type ToolCtx } from '../tinybird';
import { parseSpanRow, buildOutputSpan, type SpanRow } from '../helpers/getTrace';

interface SpanRowWithCount extends SpanRow {
  total_count: number;
}

interface GetTraceSpansParams {
  trace_id: string;
  expand?: string[];
  span_names?: string[];
  exclude_span_names?: string[];
  min_duration_ms?: number;
  sort_by?: string;
  order?: string;
  top_n?: number;
  limit?: number;
  cursor?: string;
}

export async function getTraceSpans(
  ctx: ToolCtx,
  apiKeyIds: string[],
  params: GetTraceSpansParams,
  retentionDays: number,
): Promise<ToolCallResult> {
  if (apiKeyIds.length === 0) {
    return noApiKeysError();
  }

  if (!TRACE_ID_PATTERN.test(params.trace_id)) {
    return invalidTraceIdError();
  }

  const token = await ctx.mintToken(
    [{ type: 'PIPES:READ', resource: 'mcp_trace_detail' }],
    apiKeyIds,
    retentionDays,
  );

  const baseParams: Record<string, string | number | undefined> = {
    trace_id: params.trace_id,
  };

  if (params.span_names && params.span_names.length > 0) {
    const { exact, prefixes } = splitPatterns(params.span_names);
    if (exact.length > 0) baseParams.span_names = exact.join(',');
    if (prefixes.length > 0) baseParams.span_name_prefixes = prefixes.join(',');
  }

  if (params.exclude_span_names && params.exclude_span_names.length > 0) {
    const { exact } = splitPatterns(params.exclude_span_names);
    if (exact.length > 0) baseParams.exclude_span_names = exact.join(',');
  }

  if (params.min_duration_ms !== undefined && params.min_duration_ms > 0) {
    baseParams.min_duration_ms = params.min_duration_ms;
  }

  const limit = Math.min(params.limit ?? DEFAULT_SPAN_LIMIT, MAX_SPAN_LIMIT);
  const offset = params.cursor ? parseInt(params.cursor, 10) || 0 : 0;
  const cappedTopN =
    params.top_n && params.top_n > 0 ? Math.min(params.top_n, MAX_SPAN_LIMIT) : undefined;

  const detailParams: Record<string, string | number | undefined> = {
    ...baseParams,
    limit: cappedTopN ?? limit,
    offset: cappedTopN ? 0 : offset,
  };

  if (params.sort_by) {
    detailParams.sort_by = params.sort_by;
  } else if (cappedTopN) {
    detailParams.sort_by = 'duration_ms';
  }

  if (params.order) {
    detailParams.order = params.order;
  } else if (params.sort_by || cappedTopN) {
    detailParams.order = 'desc';
  }

  const data = await queryPipe(ctx.tinybirdBaseUrl, token, 'mcp_trace_detail', detailParams);

  if (data.length === 0) {
    return traceNotFoundError(params.trace_id);
  }

  const expand = new Set(params.expand ?? []);

  const totalCount = (data[0] as unknown as SpanRowWithCount).total_count;
  const parsedSpans = data.map((row) => parseSpanRow(row as unknown as SpanRow));

  let paginatedSpans = parsedSpans;
  let hasMore: boolean;

  if (cappedTopN) {
    paginatedSpans = parsedSpans.slice(offset, offset + limit);
    hasMore = offset + limit < parsedSpans.length;
  } else {
    hasMore = totalCount > offset + data.length;
  }

  const outputSpans = paginatedSpans.map((s) => buildOutputSpan(s, expand));

  const result = {
    trace_id: params.trace_id,
    spans: outputSpans,
    pagination: {
      has_more: hasMore,
      next_cursor: hasMore ? String(offset + paginatedSpans.length) : undefined,
      total: cappedTopN ? parsedSpans.length : undefined,
    },
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(stripNulls(result), jsonReplacer) }],
  };
}
