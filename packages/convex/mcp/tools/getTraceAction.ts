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
} from './shared';

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

interface GetTraceParams {
  trace_id: string;
}

export async function getTrace(
  apiKeys: string[],
  params: GetTraceParams,
  retentionDays: number,
): Promise<ToolCallResult> {
  if (apiKeys.length === 0) {
    return noApiKeysError();
  }

  if (!TRACE_ID_PATTERN.test(params.trace_id)) {
    return invalidTraceIdError();
  }

  const pipes = ['mcp_trace_summary', 'mcp_trace_by_provider', 'mcp_trace_by_model'];
  const token = await generateTinybirdToken(
    pipes.map((p) => ({ type: 'PIPES:READ', resource: p })),
    apiKeys,
    retentionDays,
  );

  const baseParams = { trace_id: params.trace_id };

  const [summaryData, byProviderData, byModelData] = await Promise.all([
    queryTinybirdPipe(token, 'mcp_trace_summary', baseParams),
    queryTinybirdPipe(token, 'mcp_trace_by_provider', baseParams),
    queryTinybirdPipe(token, 'mcp_trace_by_model', baseParams),
  ]);

  const summaryRow = summaryData[0] as unknown as SummaryRow | undefined;

  if (!summaryRow) {
    return traceNotFoundError(params.trace_id);
  }

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
    {} as Record<string, { count: number; duration_ms: number; cost_usd: number; tokens: number }>,
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
    {} as Record<string, { count: number; duration_ms: number; cost_usd: number; tokens: number }>,
  );

  const timestamp = new Date(summaryRow.first_timestamp / 1_000_000).toISOString();
  const duration_ms =
    (summaryRow.last_timestamp - summaryRow.first_timestamp) / 1_000_000 +
    summaryRow.total_duration_ms;

  const result = {
    trace_id: params.trace_id,
    status: summaryRow.error_count > 0 ? 'error' : 'ok',
    timestamp,
    duration_ms,
    summary: {
      totals: {
        span_count: summaryRow.span_count,
        duration_ms: summaryRow.total_duration_ms,
        cost_usd: summaryRow.total_cost_usd,
        tokens: summaryRow.total_tokens,
      },
      by_provider: Object.keys(byProvider).length > 0 ? byProvider : undefined,
      by_model: Object.keys(byModel).length > 0 ? byModel : undefined,
    },
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(stripNulls(result), jsonReplacer) }],
  };
}
