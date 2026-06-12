import type { ToolCallResult } from '../protocol';
import { queryPipe, type ToolCtx } from '../tinybird';
import {
  AGENT_VIEWS,
  agentPageLimit,
  buildDiscoveryParams,
  buildPipeParams,
  buildStaticContract,
  buildWindowParams,
  invalidTimeParam,
  isAgentView,
  projectRows,
  toolError,
  valueRows,
  type AgentAnalyticsDescribeParams,
  type AgentAnalyticsParams,
} from './agentAnalyticsContract';
import { jsonToolResult } from './shared';

export async function describeAgentAnalytics(
  ctx: ToolCtx,
  apiKeyIds: string[],
  params: AgentAnalyticsDescribeParams,
  retentionDays: number,
): Promise<ToolCallResult> {
  const invalidTime = invalidTimeParam(params);
  if (invalidTime) {
    return toolError(`${invalidTime} must be an ISO date/time string`);
  }

  const window = buildWindowParams(params, retentionDays);
  const contract = buildStaticContract(window);
  if (params.include_values === false) {
    return jsonToolResult(contract);
  }

  const token = await ctx.mintToken(
    [
      { type: 'PIPES:READ', resource: 'agent_usage_breakdown' },
      { type: 'PIPES:READ', resource: 'agent_repo_directory' },
    ],
    apiKeyIds,
    retentionDays,
  );
  const baseParams = buildDiscoveryParams(params, window);
  const [sourceRows, modelRows, repoBreakdownRows] = await Promise.all([
    queryPipe(ctx.tinybirdBaseUrl, token, 'agent_usage_breakdown', {
      ...baseParams,
      dimension: 'source',
      order_by: 'message_count',
    }),
    queryPipe(ctx.tinybirdBaseUrl, token, 'agent_usage_breakdown', {
      ...baseParams,
      dimension: 'model',
      order_by: 'message_count',
    }),
    queryPipe(ctx.tinybirdBaseUrl, token, 'agent_usage_breakdown', {
      ...baseParams,
      dimension: 'repo',
      order_by: 'message_count',
    }),
  ]);
  const repoValues = valueRows(repoBreakdownRows).map((row) => String(row.value));
  const directoryRows =
    repoValues.length > 0
      ? await queryPipe(ctx.tinybirdBaseUrl, token, 'agent_repo_directory', {
          start_time_ms: window.start_time_ms,
          end_time_ms: window.end_time_ms,
          repos: repoValues.join(','),
          limit: baseParams.limit,
        })
      : [];

  return jsonToolResult({
    ...contract,
    discovered_values_limit: baseParams.limit,
    discovered_values: {
      sources: valueRows(sourceRows),
      models: valueRows(modelRows),
      repo_fingerprints: projectRows(directoryRows, repoBreakdownRows),
    },
    discovered_values_may_have_more: {
      sources: sourceRows.length === baseParams.limit,
      models: modelRows.length === baseParams.limit,
      repo_fingerprints: repoBreakdownRows.length === baseParams.limit,
    },
  });
}

export async function queryAgentAnalytics(
  ctx: ToolCtx,
  apiKeyIds: string[],
  params: AgentAnalyticsParams,
  retentionDays: number,
): Promise<ToolCallResult> {
  if (!isAgentView(params.view)) {
    return toolError(`view must be one of: ${Object.keys(AGENT_VIEWS).join(', ')}`);
  }
  const invalidTime = invalidTimeParam(params);
  if (invalidTime) {
    return toolError(`${invalidTime} must be an ISO date/time string`);
  }

  const view = params.view;
  const pipe = AGENT_VIEWS[view];
  const token = await ctx.mintToken(
    [{ type: 'PIPES:READ', resource: pipe }],
    apiKeyIds,
    retentionDays,
  );
  const window = buildWindowParams(params, retentionDays);
  const pipeParams = buildPipeParams(view, params, window);
  const data = await queryPipe(ctx.tinybirdBaseUrl, token, pipe, pipeParams);
  const pageLimit = agentPageLimit(params, view);
  const pageOffset = typeof pipeParams.offset === 'number' ? pipeParams.offset : 0;

  return jsonToolResult({
    view,
    window,
    filters: params.filters ?? {},
    data,
    pagination: pageLimit
      ? {
          limit: pageLimit,
          offset: pageOffset,
          has_more: data.length === pageLimit,
          next_offset: data.length === pageLimit ? pageOffset + data.length : undefined,
        }
      : undefined,
  });
}
