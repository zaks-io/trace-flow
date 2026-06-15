/**
 * User- and MCP-facing JWT minting is limited to PIPES:READ on published endpoint
 * pipes that enforce row security via JWT `fixed_params`. DATASOURCES:* and SQL:*
 * scopes use Tinybird `filter`, which Convex does not populate.
 *
 * Helper/materialization pipes (e.g. `agent_priced_usage`, no TYPE ENDPOINT) must
 * never appear here even if they live under `pipes/`.
 */
export const TINYBIRD_PIPES_READ_SCOPE = 'PIPES:READ' as const;

/**
 * Dashboard and MCP pipes that request JWTs via `generateToken` / `generateTokenInternal`.
 * Update when adding a new user-facing Tinybird endpoint; keep in sync with web/MCP callers.
 */
export const ALLOWED_TINYBIRD_PIPE_RESOURCES = new Set([
  'agent_context_health',
  'agent_failure_leaderboard',
  'agent_repo_directory',
  'agent_sessions_browser',
  'agent_tool_period_delta',
  'agent_usage_breakdown',
  'agent_usage_summary',
  'agent_usage_timeseries',
  'filter_options',
  'llm_cost_forecast',
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
  'operations_leaderboard',
  'trace_detail',
  'traces_for_alerts',
  'traces_grouped',
  'traces_list',
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
