import { internalAction } from '../../_generated/server';
import { v } from 'convex/values';
import type { ToolCallResult } from '../protocol';
import { jsonReplacer, stripNulls } from '../utils';
import {
  queryTinybird,
  noApiKeysError,
  invalidTraceIdError,
  traceNotFoundError,
  generateTinybirdToken,
  TRACE_ID_PATTERN,
  DEFAULT_SPAN_LIMIT,
  MAX_SPAN_LIMIT,
} from './shared';
import {
  buildGetTraceSQL,
  parseSpanRow,
  applyFilters,
  generateSummary,
  applyTopN,
  paginateSpans,
  buildOutputSpan,
  calculateTraceStats,
  type SpanRow,
} from '../helpers/getTrace';

export const getTrace = internalAction({
  args: {
    apiKeys: v.array(v.string()),
    params: v.object({
      trace_id: v.string(),
      expand: v.optional(v.array(v.string())),
      limit: v.optional(v.number()),
      cursor: v.optional(v.string()),
      span_names: v.optional(v.array(v.string())),
      top_n: v.optional(v.number()),
      sort_by: v.optional(v.string()),
      min_duration_ms: v.optional(v.number()),
      exclude_span_names: v.optional(v.array(v.string())),
      include_summary: v.optional(v.boolean()),
    }),
  },
  handler: async (_, args): Promise<ToolCallResult> => {
    const { apiKeys, params } = args;

    if (apiKeys.length === 0) {
      return noApiKeysError();
    }

    if (!TRACE_ID_PATTERN.test(params.trace_id)) {
      return invalidTraceIdError();
    }

    const token = await generateTinybirdToken([{ type: 'PIPES:READ', resource: 'otel_traces' }]);

    const sql = buildGetTraceSQL(params.trace_id, apiKeys);
    const data = await queryTinybird(token, sql);

    if (data.length === 0) {
      return traceNotFoundError(params.trace_id);
    }

    const expand = new Set(params.expand ?? []);
    const allSpans = data.map((row) => parseSpanRow(row as unknown as SpanRow));

    // Apply filters
    let filteredSpans = applyFilters(allSpans, params);
    const totalFilteredCount = filteredSpans.length;

    // Generate summary before top_n (aggregates all filtered spans)
    const summary = params.include_summary !== false ? generateSummary(filteredSpans) : undefined;

    // Apply top_n sorting if specified
    if (params.top_n && params.top_n > 0) {
      filteredSpans = applyTopN(filteredSpans, params.top_n, params.sort_by ?? 'duration_ms');
    }

    // Apply pagination
    const limit = Math.min(params.limit ?? DEFAULT_SPAN_LIMIT, MAX_SPAN_LIMIT);
    const {
      spans: paginatedSpans,
      hasMore,
      offset,
    } = paginateSpans(filteredSpans, limit, params.cursor);

    // Build output
    const outputSpans = paginatedSpans.map((s) => buildOutputSpan(s, expand));
    const { duration, hasError } = calculateTraceStats(allSpans);

    const result = {
      trace_id: params.trace_id,
      span_count: allSpans.length,
      duration_ms: duration,
      status: hasError ? 'error' : 'ok',
      summary,
      spans: outputSpans,
      pagination: {
        has_more: hasMore,
        next_cursor: hasMore ? String(offset + limit) : undefined,
        total: totalFilteredCount,
      },
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(stripNulls(result), jsonReplacer) }],
    };
  },
});
