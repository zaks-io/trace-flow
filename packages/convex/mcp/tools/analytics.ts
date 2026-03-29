import type { ToolCallResult } from '../protocol';
import {
  buildTimeRangeNs,
  generateTinybirdToken,
  jsonReplacer,
  noApiKeysError,
  queryTinybirdPipe,
  stripNulls,
} from './shared';

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
  avg_duration_ms: number;
  max_duration_ms: number;
  p95_duration_ms: number;
}

interface UsageSummaryRow extends BaseUsageRow {
  error_count: number;
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

const DEFAULT_BREAKDOWN_LIMIT = 20;
const MAX_BREAKDOWN_LIMIT = 100;

function buildTokens(row: BaseUsageRow) {
  return {
    input: row.input_tokens,
    uncached_input: row.uncached_input_tokens,
    output: row.output_tokens,
    cache_read_input: row.cache_read_input_tokens,
    cache_creation_input: row.cache_creation_input_tokens,
    reasoning: row.reasoning_tokens,
    total: row.total_tokens,
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
  apiKeys: string[],
  params: AnalyticsParams,
): Promise<ToolCallResult> {
  if (apiKeys.length === 0) {
    return noApiKeysError();
  }

  const token = await generateTinybirdToken(
    [{ type: 'PIPES:READ', resource: 'llm_usage_summary' }],
    apiKeys,
  );
  const { hours, pipeParams } = buildPipeParams(params);
  const data = await queryTinybirdPipe(token, 'llm_usage_summary', pipeParams);
  const row = data[0] as unknown as UsageSummaryRow | undefined;

  const result = {
    window: { hours },
    summary: row
      ? {
          request_count: row.request_count,
          error_count: row.error_count,
          error_rate: row.request_count > 0 ? row.error_count / row.request_count : 0,
          tokens: buildTokens(row),
          cost_usd: buildCosts(row),
          duration_ms: buildDurations(row),
        }
      : undefined,
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(stripNulls(result), jsonReplacer) }],
  };
}

export async function listOperationUsage(
  apiKeys: string[],
  params: AnalyticsParams,
): Promise<ToolCallResult> {
  if (apiKeys.length === 0) {
    return noApiKeysError();
  }

  const token = await generateTinybirdToken(
    [{ type: 'PIPES:READ', resource: 'operations_leaderboard' }],
    apiKeys,
  );
  const { hours, pipeParams } = buildPipeParams(params);
  pipeParams.limit = Math.min(params.limit ?? DEFAULT_BREAKDOWN_LIMIT, MAX_BREAKDOWN_LIMIT);

  const data = await queryTinybirdPipe(token, 'operations_leaderboard', pipeParams);
  const rows = data as unknown as OperationUsageRow[];

  const result = {
    window: { hours },
    operations: rows.map((row) => ({
      operation: row.operation,
      request_count: row.request_count,
      unique_user_count: row.unique_user_count,
      tokens: buildTokens(row),
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
  apiKeys: string[],
  params: AnalyticsParams,
): Promise<ToolCallResult> {
  if (apiKeys.length === 0) {
    return noApiKeysError();
  }

  const token = await generateTinybirdToken(
    [{ type: 'PIPES:READ', resource: 'llm_usage_by_model' }],
    apiKeys,
  );
  const { hours, pipeParams } = buildPipeParams(params);
  const data = await queryTinybirdPipe(token, 'llm_usage_by_model', pipeParams);
  const rows = data as unknown as ModelUsageRow[];

  const result = {
    window: { hours },
    models: rows.map((row) => ({
      model: row.model,
      request_count: row.request_count,
      tokens: buildTokens(row),
      cost_usd: buildCosts(row),
      duration_ms: buildDurations(row),
      cost_per_1k_output_tokens: row.cost_per_1k_output_tokens,
    })),
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(stripNulls(result), jsonReplacer) }],
  };
}
