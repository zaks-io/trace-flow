import type { ToolCallResult } from '../protocol';
import {
  noApiKeysError,
  invalidTraceIdError,
  TRACE_ID_PATTERN,
  DEFAULT_SPAN_LIMIT,
  MAX_SPAN_LIMIT,
  addPatternParams,
  jsonReplacer,
  mintPipeReadToken,
  offsetPaginationResult,
  resolveOffsetPagination,
} from './shared';
import { queryPipe, type ToolCtx } from '../tinybird';
import { parseSpanRow, buildOutputSpan, type SpanRow } from '../helpers/getTrace';

interface SpanRowWithCount extends SpanRow {
  total_count: number;
}

interface TraceSpansResult {
  trace_id: string;
  spans: Record<string, unknown>[];
  pagination: ReturnType<typeof offsetPaginationResult>;
}

function traceSpansResult(result: TraceSpansResult): ToolCallResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(result, jsonReplacer) }],
  };
}

interface GetTraceSpansParams {
  trace_id?: string;
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

  const traceId = params.trace_id;
  if (!traceId || !TRACE_ID_PATTERN.test(traceId)) {
    return invalidTraceIdError();
  }

  const token = await mintPipeReadToken(ctx, apiKeyIds, retentionDays, 'mcp_trace_detail');

  const baseParams: Record<string, string | number | undefined> = {
    trace_id: traceId,
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

  const data = await queryPipe<SpanRowWithCount>(
    ctx.tinybirdBaseUrl,
    token,
    'mcp_trace_detail',
    detailParams,
  );

  const firstRow = data[0];
  if (!firstRow) {
    return traceSpansResult({
      trace_id: traceId,
      spans: [],
      pagination: offsetPaginationResult(pagination, 0, 0, {
        total: cappedTopN ? 0 : undefined,
      }),
    });
  }

  const expand = new Set(params.expand ?? []);

  const totalCount = firstRow.total_count;
  const parsedSpans = data.map(parseSpanRow);

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
    trace_id: traceId,
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

  return traceSpansResult(result);
}
