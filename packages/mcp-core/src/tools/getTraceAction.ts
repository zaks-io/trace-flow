import type { ToolCallResult } from '../protocol';
import {
  noApiKeysError,
  invalidTraceIdError,
  traceNotFoundError,
  TRACE_ID_PATTERN,
  indexMetricRows,
  jsonToolResult,
  mintPipeReadToken,
} from './shared';
import { queryPipe, type ToolCtx } from '../tinybird';

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
  trace_id?: string;
}

export async function getTrace(
  ctx: ToolCtx,
  apiKeyIds: string[],
  params: GetTraceParams,
  retentionDays: number,
): Promise<ToolCallResult> {
  if (apiKeyIds.length === 0) {
    return noApiKeysError();
  }

  const traceId = params.trace_id;
  if (!traceId || !TRACE_ID_PATTERN.test(traceId)) {
    return invalidTraceIdError();
  }

  const pipes = ['mcp_trace_summary', 'mcp_trace_by_provider', 'mcp_trace_by_model'];
  const token = await mintPipeReadToken(ctx, apiKeyIds, retentionDays, pipes);

  const baseParams = { trace_id: traceId };

  const [summaryData, byProviderData, byModelData] = await Promise.all([
    queryPipe<SummaryRow>(ctx.tinybirdBaseUrl, token, 'mcp_trace_summary', baseParams),
    queryPipe<ByProviderRow>(ctx.tinybirdBaseUrl, token, 'mcp_trace_by_provider', baseParams),
    queryPipe<ByModelRow>(ctx.tinybirdBaseUrl, token, 'mcp_trace_by_model', baseParams),
  ]);

  const summaryRow = summaryData[0];

  if (!summaryRow) {
    return traceNotFoundError(traceId);
  }

  const byProvider = indexMetricRows(byProviderData, 'provider');
  const byModel = indexMetricRows(byModelData, 'model');

  const timestamp = new Date(summaryRow.first_timestamp / 1_000_000).toISOString();
  const duration_ms =
    (summaryRow.last_timestamp - summaryRow.first_timestamp) / 1_000_000 +
    summaryRow.total_duration_ms;

  const result = {
    trace_id: traceId,
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

  return jsonToolResult(result);
}
