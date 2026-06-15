/**
 * User- and MCP-facing JWT minting is limited to PIPES:READ on known dashboard/MCP
 * pipes. DATASOURCES:* and SQL:* scopes use Tinybird `filter` row security, which
 * Convex does not populate — allowing them would bypass tenant isolation.
 */
export const TINYBIRD_PIPES_READ_SCOPE = 'PIPES:READ' as const;

/** Pipes shipped in `pipes/` and used by the dashboard, MCP, or internal alerts. */
export const ALLOWED_TINYBIRD_PIPE_RESOURCES = new Set([
  'agent_context_health',
  'agent_failure_leaderboard',
  'agent_priced_coverage',
  'agent_priced_usage',
  'agent_repo_directory',
  'agent_sessions_browser',
  'agent_tool_period_delta',
  'agent_usage_breakdown',
  'agent_usage_summary',
  'agent_usage_timeseries',
  'filter_options',
  'llm_cost_forecast',
  'llm_cost_hourly_spike',
  'llm_request_stats',
  'llm_usage_by_api_key',
  'llm_usage_by_model',
  'llm_usage_by_provider',
  'llm_usage_summary',
  'llm_usage_timeseries',
  'mcp_trace_by_model',
  'mcp_trace_by_provider',
  'mcp_trace_detail',
  'mcp_trace_events',
  'mcp_trace_summaries',
  'mcp_trace_summary',
  'mcp_traces_list',
  'operation_user_breakdown',
  'operations_filter_options',
  'operations_leaderboard',
  'trace_capture_lag',
  'trace_detail',
  'traces_for_alerts',
  'traces_grouped',
  'traces_list',
  'traces_models',
  'traces_providers',
  'traces_summary',
]);

export interface TinybirdMintScope {
  type: string;
  resource: string;
}

export function assertMintableTinybirdScopes(scopes: TinybirdMintScope[]): void {
  if (scopes.length === 0) {
    throw new Error('At least one Tinybird scope is required');
  }

  for (const scope of scopes) {
    if (scope.type !== TINYBIRD_PIPES_READ_SCOPE) {
      throw new Error(`Tinybird scope type not allowed: ${scope.type}`);
    }
    if (!ALLOWED_TINYBIRD_PIPE_RESOURCES.has(scope.resource)) {
      throw new Error(`Tinybird pipe not allowed: ${scope.resource}`);
    }
  }
}
