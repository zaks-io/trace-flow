import type { ToolCallResult } from '../protocol';
import {
  buildTimeRangeNs,
  clampAnalyticsLimit,
  jsonReplacer,
  noApiKeysError,
  stripNulls,
} from './shared';
import { queryPipe, type ToolCtx } from '../tinybird';

interface AnalyticsParams {
  hours?: number;
  provider?: string;
  model?: string;
  operation?: string;
  status?: string;
  limit?: number;
}

interface BaseUsageRow {
  request_count: number;
  input_tokens: number;
  uncached_input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  reasoning_tokens: number;
  total_cost_usd: number;
  input_cost_usd: number;
  output_cost_usd: number;
  cache_read_cost_usd: number;
  cache_creation_cost_usd: number;
  reasoning_cost_usd: number;
  prompt_baseline_cost_usd: number;
  cache_impact_cost_usd: number;
  upstream_cost_usd: number;
  total_tokens: number;
  unclassified_tokens: number;
  usage_complete_count: number;
  usage_inconsistent_count: number;
  usage_unclassified_count: number;
  usage_missing_count: number;
  avg_duration_ms: number;
  max_duration_ms: number;
  p95_duration_ms: number;
}

interface UsageSummaryRow extends BaseUsageRow {
  error_count: number;
  cost_priced_count: number;
  cost_partial_count: number;
  cost_unpriced_count: number;
  cost_priced_tokens: number;
  cost_proxy_count: number;
  cost_unassessed_count: number;
  cost_coverage_ratio: number | null;
}

interface OperationUsageRow extends BaseUsageRow {
  operation: string;
  unique_user_count: number;
  cost_per_request_usd?: number;
  cost_per_user_usd?: number;
  cache_hit_rate?: number;
}

interface ModelUsageRow extends BaseUsageRow {
  model: string;
  cost_per_1k_output_tokens?: number;
}

function buildTokens(row: BaseUsageRow) {
  return {
    input: row.input_tokens,
    uncached_input: row.uncached_input_tokens,
    output: row.output_tokens,
    cache_read_input: row.cache_read_input_tokens,
    cache_creation_input: row.cache_creation_input_tokens,
    reasoning: row.reasoning_tokens,
    total: row.total_tokens,
    unclassified: row.unclassified_tokens,
  };
}

function buildUsageCounts(row: BaseUsageRow) {
  return {
    usage_complete_count: row.usage_complete_count,
    usage_inconsistent_count: row.usage_inconsistent_count,
    usage_unclassified_count: row.usage_unclassified_count,
    usage_missing_count: row.usage_missing_count,
  };
}

function buildCosts(row: BaseUsageRow) {
  return {
    total: row.total_cost_usd,
    input: row.input_cost_usd,
    output: row.output_cost_usd,
    cache_read: row.cache_read_cost_usd,
    cache_creation: row.cache_creation_cost_usd,
    reasoning: row.reasoning_cost_usd,
    prompt_baseline: row.prompt_baseline_cost_usd,
    cache_impact: row.cache_impact_cost_usd,
    upstream: row.upstream_cost_usd,
  };
}

function buildDurations(row: BaseUsageRow) {
  return {
    avg: row.avg_duration_ms,
    max: row.max_duration_ms,
    p95: row.p95_duration_ms,
  };
}

function buildPipeParams(params: AnalyticsParams) {
  const { hours, startTimeNs, endTimeNs } = buildTimeRangeNs(params.hours);
  const pipeParams: Record<string, string | number | undefined> = {
    start_time_ns: startTimeNs,
    end_time_ns: endTimeNs,
  };

  if (params.provider) pipeParams.provider = params.provider;
  if (params.model) pipeParams.model = params.model;
  if (params.operation) pipeParams.baggage_operation = params.operation;
  if (params.status) pipeParams.status = params.status;

  return { hours, pipeParams };
}

export async function getUsageSummary(
  ctx: ToolCtx,
  apiKeyIds: string[],
  params: AnalyticsParams,
  retentionDays: number,
): Promise<ToolCallResult> {
  if (apiKeyIds.length === 0) {
    return noApiKeysError();
  }

  const token = await ctx.mintToken(
    [{ type: 'PIPES:READ', resource: 'llm_usage_summary' }],
    apiKeyIds,
    retentionDays,
  );
  const { hours, pipeParams } = buildPipeParams(params);
  const data = await queryPipe<UsageSummaryRow>(ctx, token, 'llm_usage_summary', pipeParams);
  const row = data[0];

  const result = {
    window: { hours },
    summary: row
      ? {
          request_count: row.request_count,
          error_count: row.error_count,
          error_rate: row.request_count > 0 ? row.error_count / row.request_count : 0,
          tokens: buildTokens(row),
          ...buildUsageCounts(row),
          cost_usd: buildCosts(row),
          cost_priced_count: row.cost_priced_count,
          cost_partial_count: row.cost_partial_count,
          cost_unpriced_count: row.cost_unpriced_count,
          cost_priced_tokens: row.cost_priced_tokens,
          cost_proxy_count: row.cost_proxy_count,
          cost_unassessed_count: row.cost_unassessed_count,
          cost_coverage_ratio: row.cost_coverage_ratio,
          duration_ms: buildDurations(row),
        }
      : undefined,
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(stripNulls(result), jsonReplacer) }],
  };
}

export async function listOperationUsage(
  ctx: ToolCtx,
  apiKeyIds: string[],
  params: AnalyticsParams,
  retentionDays: number,
): Promise<ToolCallResult> {
  if (apiKeyIds.length === 0) {
    return noApiKeysError();
  }

  const token = await ctx.mintToken(
    [{ type: 'PIPES:READ', resource: 'operations_leaderboard' }],
    apiKeyIds,
    retentionDays,
  );
  const { hours, pipeParams } = buildPipeParams(params);
  pipeParams.limit = clampAnalyticsLimit(params.limit);

  const rows = await queryPipe<OperationUsageRow>(ctx, token, 'operations_leaderboard', pipeParams);

  const result = {
    window: { hours },
    operations: rows.map((row) => ({
      operation: row.operation,
      request_count: row.request_count,
      unique_user_count: row.unique_user_count,
      tokens: buildTokens(row),
      ...buildUsageCounts(row),
      cost_usd: buildCosts(row),
      duration_ms: buildDurations(row),
      cost_per_request_usd: row.cost_per_request_usd,
      cost_per_user_usd: row.cost_per_user_usd,
      cache_hit_rate: row.cache_hit_rate,
    })),
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(stripNulls(result), jsonReplacer) }],
  };
}

export async function listModelUsage(
  ctx: ToolCtx,
  apiKeyIds: string[],
  params: AnalyticsParams,
  retentionDays: number,
): Promise<ToolCallResult> {
  if (apiKeyIds.length === 0) {
    return noApiKeysError();
  }

  const token = await ctx.mintToken(
    [{ type: 'PIPES:READ', resource: 'llm_usage_by_model' }],
    apiKeyIds,
    retentionDays,
  );
  const { hours, pipeParams } = buildPipeParams(params);
  pipeParams.limit = clampAnalyticsLimit(params.limit);
  const rows = await queryPipe<ModelUsageRow>(ctx, token, 'llm_usage_by_model', pipeParams);

  const result = {
    window: { hours },
    models: rows.map((row) => ({
      model: row.model,
      request_count: row.request_count,
      tokens: buildTokens(row),
      ...buildUsageCounts(row),
      cost_usd: buildCosts(row),
      duration_ms: buildDurations(row),
      cost_per_1k_output_tokens: row.cost_per_1k_output_tokens,
    })),
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(stripNulls(result), jsonReplacer) }],
  };
}
