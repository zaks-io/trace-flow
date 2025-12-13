import { internalAction } from '../../_generated/server';
import { v } from 'convex/values';
import type { ToolCallResult } from '../protocol';
import {
  jsonReplacer,
  stripNulls,
  queryTinybirdPipe,
  noApiKeysError,
  invalidTraceIdError,
  traceNotFoundError,
  generateTinybirdToken,
  TRACE_ID_PATTERN,
  DEFAULT_SPAN_LIMIT,
  MAX_SPAN_LIMIT,
} from './shared';
import { parseSpanRow, buildOutputSpan, type SpanRow, type ParsedSpan } from '../helpers/getTrace';

interface SummaryRow {
  span_count: number;
  total_duration_ms: number;
  total_cost_usd: number;
  total_tokens: number;
  error_count: number;
  first_timestamp: number;
  last_timestamp: number;
}

interface ByProviderRow {
  provider: string;
  count: number;
  duration_ms: number;
  cost_usd: number;
  tokens: number;
}

interface ByModelRow {
  model: string;
  count: number;
  duration_ms: number;
  cost_usd: number;
  tokens: number;
}

function splitPatterns(patterns: string[]): { exact: string[]; prefixes: string[] } {
  const exact: string[] = [];
  const prefixes: string[] = [];
  for (const p of patterns) {
    if (p.endsWith('.*')) {
      prefixes.push(p.slice(0, -1)); // Remove * but keep the .
    } else {
      exact.push(p);
    }
  }
  return { exact, prefixes };
}

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

    // Generate token with Pipe access
    const pipes = [
      'mcp_trace_detail',
      'mcp_trace_summary',
      'mcp_trace_by_provider',
      'mcp_trace_by_model',
    ];
    const token = await generateTinybirdToken(
      pipes.map((p) => ({ type: 'PIPES:READ', resource: p })),
      apiKeys,
    );

    // Build pipe parameters
    const baseParams: Record<string, string | number | undefined> = {
      trace_id: params.trace_id,
    };

    // Handle span_names patterns - split into exact and prefix patterns
    if (params.span_names && params.span_names.length > 0) {
      const { exact, prefixes } = splitPatterns(params.span_names);
      if (exact.length > 0) baseParams.span_names = exact.join(',');
      if (prefixes.length > 0) baseParams.span_name_prefixes = prefixes.join(',');
    }

    if (params.exclude_span_names && params.exclude_span_names.length > 0) {
      // For exclusions, we only support exact matches in the Pipe
      const { exact } = splitPatterns(params.exclude_span_names);
      if (exact.length > 0) baseParams.exclude_span_names = exact.join(',');
    }

    if (params.min_duration_ms !== undefined && params.min_duration_ms > 0) {
      baseParams.min_duration_ms = params.min_duration_ms;
    }

    // Apply pagination and sorting at pipe level
    const limit = Math.min(params.limit ?? DEFAULT_SPAN_LIMIT, MAX_SPAN_LIMIT);
    const offset = params.cursor ? parseInt(params.cursor, 10) || 0 : 0;

    const detailParams: Record<string, string | number | undefined> = {
      ...baseParams,
      limit: params.top_n && params.top_n > 0 ? params.top_n : limit + 1, // +1 to check hasMore
      offset: params.top_n && params.top_n > 0 ? 0 : offset,
    };

    if (params.sort_by) {
      detailParams.sort_by = params.sort_by;
    } else if (params.top_n && params.top_n > 0) {
      detailParams.sort_by = 'duration_ms'; // Default sort for top_n
    }

    // Fetch spans from pipe
    const data = await queryTinybirdPipe(token, 'mcp_trace_detail', detailParams);

    if (data.length === 0) {
      return traceNotFoundError(params.trace_id);
    }

    const expand = new Set(params.expand ?? []);
    let allSpans = data.map((row) => parseSpanRow(row as unknown as SpanRow));

    // If top_n was applied, we need to re-paginate the results
    let paginatedSpans: ParsedSpan[];
    let hasMore: boolean;

    if (params.top_n && params.top_n > 0) {
      // top_n was applied at pipe level, now paginate
      paginatedSpans = allSpans.slice(offset, offset + limit);
      hasMore = offset + limit < allSpans.length;
    } else {
      // Pagination was applied at pipe level
      hasMore = allSpans.length > limit;
      paginatedSpans = hasMore ? allSpans.slice(0, limit) : allSpans;
      allSpans = paginatedSpans; // For count purposes
    }

    // Fetch summary if requested
    let summary: Record<string, unknown> | undefined;
    if (params.include_summary !== false) {
      const [summaryData, byProviderData, byModelData] = await Promise.all([
        queryTinybirdPipe(token, 'mcp_trace_summary', baseParams),
        queryTinybirdPipe(token, 'mcp_trace_by_provider', baseParams),
        queryTinybirdPipe(token, 'mcp_trace_by_model', baseParams),
      ]);

      const summaryRow = summaryData[0] as unknown as SummaryRow | undefined;
      const byProvider = (byProviderData as unknown as ByProviderRow[]).reduce(
        (acc, row) => {
          acc[row.provider] = {
            count: row.count,
            duration_ms: row.duration_ms,
            cost_usd: row.cost_usd,
            tokens: row.tokens,
          };
          return acc;
        },
        {} as Record<
          string,
          { count: number; duration_ms: number; cost_usd: number; tokens: number }
        >,
      );
      const byModel = (byModelData as unknown as ByModelRow[]).reduce(
        (acc, row) => {
          acc[row.model] = {
            count: row.count,
            duration_ms: row.duration_ms,
            cost_usd: row.cost_usd,
            tokens: row.tokens,
          };
          return acc;
        },
        {} as Record<
          string,
          { count: number; duration_ms: number; cost_usd: number; tokens: number }
        >,
      );

      if (summaryRow) {
        summary = {
          totals: {
            count: summaryRow.span_count,
            duration_ms: summaryRow.total_duration_ms,
            cost_usd: summaryRow.total_cost_usd,
            tokens: summaryRow.total_tokens,
          },
          by_provider: Object.keys(byProvider).length > 0 ? byProvider : undefined,
          by_model: Object.keys(byModel).length > 0 ? byModel : undefined,
        };
      }
    }

    // Build output
    const outputSpans = paginatedSpans.map((s) => buildOutputSpan(s, expand));

    // Calculate trace stats from summary or spans
    const summaryRow = summary?.totals as
      | { count: number; duration_ms: number; cost_usd: number; tokens: number }
      | undefined;
    const spanCount = summaryRow?.count ?? allSpans.length;
    const hasError = allSpans.some((s) => s.status === 'error');

    // Calculate duration from first/last span timestamps
    const timestamps = allSpans.map((s) => new Date(s.timestamp).getTime());
    const duration = timestamps.length > 0 ? Math.max(...timestamps) - Math.min(...timestamps) : 0;

    const result = {
      trace_id: params.trace_id,
      span_count: spanCount,
      duration_ms: duration,
      status: hasError ? 'error' : 'ok',
      summary,
      spans: outputSpans,
      pagination: {
        has_more: hasMore,
        next_cursor: hasMore ? String(offset + paginatedSpans.length) : undefined,
        total: params.top_n && params.top_n > 0 ? allSpans.length : spanCount,
      },
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(stripNulls(result), jsonReplacer) }],
    };
  },
});
