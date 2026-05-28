/** Source dimension filter; '' means all sources. */
export type AgentSource = '' | 'claude' | 'codex' | 'cursor';

export const AGENT_SOURCES: Exclude<AgentSource, ''>[] = ['claude', 'codex', 'cursor'];

/** Output of `pipes/agent_failure_leaderboard.pipe`. */
export interface FailureLeaderboardRow {
  tool_name: string;
  command_family: string;
  event_count: number;
  success_count: number;
  failure_count: number;
  unknown_count: number;
  /** null when success+failure = 0 (only unknown-status events). */
  failure_rate: number | null;
}

/** Output of `pipes/agent_tool_period_delta.pipe`. */
export interface ToolDeltaRow {
  tool_name: string;
  command_family: string;
  current_count: number;
  prior_count: number;
  count_delta: number;
  current_failures: number;
  prior_failures: number;
  failure_delta: number;
}

/** Output of `pipes/agent_session_outliers.pipe`. */
export interface SessionOutlierRow {
  session_pk: string;
  source: string;
  repo_fingerprint: string;
  message_count: number;
  file_event_count: number;
  unique_file_count: number;
  /** Sum of priced messages; null when every message in the session is unpriced. */
  cost_usd: number | null;
}

/** Single-row output of `pipes/agent_priced_coverage.pipe`. */
export interface CoverageRow {
  message_count: number;
  billable_message_count: number;
  priced_message_count: number;
  /** null when no billable (assistant) turns exist; else the priced share 0.0–1.0. */
  coverage_pct: number | null;
  /** sum(cost_usd); null when no priced turns exist in the window. */
  estimated_cost_usd: number | null;
}
