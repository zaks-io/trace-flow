import type { ToolCallResult } from '../protocol';
import {
  noApiKeysError,
  invalidTraceIdError,
  traceNotFoundError,
  TRACE_ID_PATTERN,
  DEFAULT_SPAN_LIMIT,
  MAX_SPAN_LIMIT,
  addPatternParams,
  jsonToolResult,
  mintPipeReadToken,
  offsetPaginationResult,
  resolveOffsetPagination,
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

  const token = await mintPipeReadToken(ctx, apiKeyIds, retentionDays, 'mcp_trace_detail');

  const baseParams: Record<string, string | number | undefined> = {
    trace_id: params.trace_id,
  };

  addPatternParams(baseParams, params.span_names, 'span_names', 'span_name_prefixes');
  addPatternParams(baseParams, params.exclude_span_names, 'exclude_span_names');

  if (params.min_duration_ms !== undefined && params.min_duration_ms > 0) {
    baseParams.min_duration_ms = params.min_duration_ms;
  }

  const pagination = resolveOffsetPagination(
    params.limit,
    params.cursor,
    DEFAULT_SPAN_LIMIT,
    MAX_SPAN_LIMIT,
  );
  const cappedTopN =
    params.top_n && params.top_n > 0 ? Math.min(params.top_n, MAX_SPAN_LIMIT) : undefined;

  const detailParams: Record<string, string | number | undefined> = {
    ...baseParams,
    limit: cappedTopN ?? pagination.limit,
    offset: cappedTopN ? 0 : pagination.offset,
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
    paginatedSpans = parsedSpans.slice(pagination.offset, pagination.offset + pagination.limit);
    hasMore = pagination.offset + pagination.limit < parsedSpans.length;
  } else {
    hasMore = totalCount > pagination.offset + data.length;
  }

  const outputSpans = paginatedSpans.map((s) => buildOutputSpan(s, expand));

  const result = {
    trace_id: params.trace_id,
    spans: outputSpans,
    pagination: {
      ...offsetPaginationResult(
        pagination,
        paginatedSpans.length,
        cappedTopN ? parsedSpans.length : totalCount,
        { total: cappedTopN ? parsedSpans.length : undefined },
      ),
      has_more: hasMore,
    },
  };

  return jsonToolResult(result);
}
