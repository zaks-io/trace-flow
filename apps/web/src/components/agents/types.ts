import type { ChartConfig } from '@/components/ui/chart';

/** Canonical agent sources (the static Source filter options). */
export const AGENT_SOURCES = ['claude', 'codex', 'cursor'] as const;

/** Hero-chart metric switcher. Cost is the default and is always an estimate. */
export type AgentMetric = 'cost' | 'tokens' | 'messages' | 'sessions' | 'tool-events';

export const AGENT_METRICS: AgentMetric[] = [
  'cost',
  'tokens',
  'messages',
  'sessions',
  'tool-events',
];

/** In-chart split dimension. Tool Events carry no model, so model is usage-only. */
export type AgentGroupBy = 'none' | 'source' | 'model' | 'repo';

export const AGENT_GROUP_BY: AgentGroupBy[] = ['none', 'source', 'model', 'repo'];

export const AGENT_GROUP_BY_LABEL: Record<AgentGroupBy, string> = {
  none: 'None',
  source: 'Source',
  model: 'Model',
  repo: 'Repo',
};

/** Repo is high-cardinality, so grouping by repo caps the chart at the top-N series + "Other". */
export const REPO_TOP_N = 8;

/** Output of `pipes/agent_repo_directory.pipe` — raw fields the client resolves to a name. */
export interface AgentRepoDirectoryRow {
  repo_fingerprint: string;
  normalized_git_remote: string;
  repo_path_fallback: string;
  repo_source: string;
}

/** Stacked area shows composition + total; line un-stacks to compare trends across series. */
export type AgentChartStyle = 'stacked' | 'line';

/**
 * Hero-chart bucket size. 'auto' defers to the pipe (hourly <= 30d, daily beyond); 'hour'
 * and 'day' force a grain regardless of window. Only the time-series honors it.
 */
export type AgentGranularity = 'auto' | 'hour' | 'day';

/** Single-row output of `pipes/agent_usage_summary.pipe` — current window + prior period. */
export interface AgentSummaryRow {
  /** Estimated cost (lower bound) for the window; sums priced turns only. */
  estimated_cost_usd: number;
  total_tokens: number;
  /** Billable (assistant) message count. */
  message_count: number;
  session_count: number;
  priced_message_count: number;
  /** Priced share of billable turns 0.0–1.0; null when no billable turns exist. */
  coverage_pct: number | null;
  prior_cost_usd: number;
  prior_total_tokens: number;
  prior_message_count: number;
  prior_session_count: number;
}

/** One row from `pipes/agent_context_health.pipe`. `group_value` is empty for the aggregate row. */
export interface AgentContextHealthRow {
  group_value: string;
  attention_threshold_tokens: number;
  model_call_count: number;
  prior_model_call_count: number;
  session_count: number;
  prior_session_count: number;
  first_call_context_p50: number;
  prior_first_call_context_p50: number;
  context_p50: number;
  prior_context_p50: number;
  context_p90: number;
  prior_context_p90: number;
  context_p95: number;
  prior_context_p95: number;
  context_max: number;
  prior_context_max: number;
  calls_over_threshold: number;
  prior_calls_over_threshold: number;
  pct_calls_over_threshold: number;
  prior_pct_calls_over_threshold: number;
  sessions_over_threshold: number;
  prior_sessions_over_threshold: number;
  pct_sessions_over_threshold: number;
  prior_pct_sessions_over_threshold: number;
  context_overage_tokens: number;
  prior_context_overage_tokens: number;
  cost_while_over_threshold: number;
  prior_cost_while_over_threshold: number;
  output_tokens_while_over_threshold: number;
  prior_output_tokens_while_over_threshold: number;
  bloated_start_25k_sessions: number;
  prior_bloated_start_25k_sessions: number;
  pct_bloated_start_25k: number;
  prior_pct_bloated_start_25k: number;
  bloated_start_50k_sessions: number;
  prior_bloated_start_50k_sessions: number;
  pct_bloated_start_50k: number;
  prior_pct_bloated_start_50k: number;
  bloated_start_100k_sessions: number;
  prior_bloated_start_100k_sessions: number;
  pct_bloated_start_100k: number;
  prior_pct_bloated_start_100k: number;
}

export const AGENT_CONTEXT_BREAKDOWN_DIMENSIONS = ['source', 'model', 'repo'] as const;
export type AgentContextBreakdownDimension = (typeof AGENT_CONTEXT_BREAKDOWN_DIMENSIONS)[number];

/** One bucketed row from `pipes/agent_usage_timeseries.pipe`. */
export interface AgentTimeseriesRow {
  /** Bucket start as a ClickHouse DateTime string (hourly or daily granularity). */
  bucket_start: string;
  /** Group dimension value when group_by is set; '' when ungrouped. */
  group_value: string;
  message_count: number;
  session_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
  /** Estimated cost (lower bound); sums priced turns only. */
  cost_usd: number;
  priced_message_count: number;
  tool_event_count: number;
  tool_success_count: number;
  tool_failure_count: number;
  tool_unknown_count: number;
}

// Cost has no per-component breakdown in the agent data model (one estimated cost_usd
// per Agent Message), so it renders as a single series. Tokens stack by component and
// tool-events by outcome. Config keys are the AgentTimeseriesRow dataKeys the chart reads.
const agentCostChartConfig = {
  cost_usd: { label: 'Estimated Cost', color: 'var(--color-chart-1)' },
} satisfies ChartConfig;

const agentTokensChartConfig = {
  input_tokens: { label: 'Input', color: 'var(--color-chart-1)' },
  output_tokens: { label: 'Output', color: 'var(--color-chart-2)' },
  cache_read_tokens: { label: 'Cache Read', color: 'var(--color-chart-3)' },
  cache_creation_tokens: { label: 'Cache Write', color: 'var(--color-chart-4)' },
  reasoning_tokens: { label: 'Reasoning', color: 'var(--color-chart-5)' },
} satisfies ChartConfig;

const agentMessagesChartConfig = {
  message_count: { label: 'Messages', color: 'var(--color-chart-4)' },
} satisfies ChartConfig;

const agentSessionsChartConfig = {
  session_count: { label: 'Sessions', color: 'var(--color-chart-7)' },
} satisfies ChartConfig;

const agentToolEventsChartConfig = {
  tool_success_count: { label: 'Success', color: 'var(--color-chart-3)' },
  tool_failure_count: { label: 'Failure', color: 'var(--color-chart-6)' },
  tool_unknown_count: { label: 'Unknown', color: 'var(--color-chart-8)' },
} satisfies ChartConfig;

/** dataKeys stacked for each metric, in render order. Drives the chart and its legend. */
export const AGENT_METRIC_KEYS: Record<AgentMetric, readonly string[]> = {
  cost: ['cost_usd'],
  tokens: [
    'input_tokens',
    'output_tokens',
    'cache_read_tokens',
    'cache_creation_tokens',
    'reasoning_tokens',
  ],
  messages: ['message_count'],
  sessions: ['session_count'],
  'tool-events': ['tool_success_count', 'tool_failure_count', 'tool_unknown_count'],
};

export const AGENT_METRIC_CONFIG: Record<AgentMetric, ChartConfig> = {
  cost: agentCostChartConfig,
  tokens: agentTokensChartConfig,
  messages: agentMessagesChartConfig,
  sessions: agentSessionsChartConfig,
  'tool-events': agentToolEventsChartConfig,
};

/** 'currency' formats the y-axis/tooltip as estimated USD; 'count' as a plain number. */
export const AGENT_METRIC_VALUE_KIND: Record<AgentMetric, 'currency' | 'count'> = {
  cost: 'currency',
  tokens: 'count',
  messages: 'count',
  sessions: 'count',
  'tool-events': 'count',
};

/**
 * The single AgentTimeseriesRow scalar each metric collapses to when grouped by a
 * dimension (the chart then stacks that scalar by group value instead of by component).
 */
export const AGENT_GROUPED_METRIC_KEY: Record<AgentMetric, keyof AgentTimeseriesRow> = {
  cost: 'cost_usd',
  tokens: 'total_tokens',
  messages: 'message_count',
  sessions: 'session_count',
  'tool-events': 'tool_event_count',
};

/** Palette for dynamic group-value series; cycles when there are more groups than colors. */
export const AGENT_GROUP_COLORS = [
  'var(--color-chart-1)',
  'var(--color-chart-2)',
  'var(--color-chart-3)',
  'var(--color-chart-4)',
  'var(--color-chart-5)',
  'var(--color-chart-6)',
  'var(--color-chart-7)',
  'var(--color-chart-8)',
] as const;

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

/**
 * Single-row output of `pipes/agent_session_size_distribution.pipe` — the per-session
 * messages/tokens distribution for the current window plus the prior equal-length window.
 * The pipe emits no row when both windows are empty (no sessions), so callers treat a
 * missing row as no-data.
 */
export interface AgentSessionSizeRow {
  session_count: number;
  prior_session_count: number;
  /** Median messages per session; p90/p95 expose the heavy tail. */
  messages_p50: number;
  prior_messages_p50: number;
  messages_p90: number;
  prior_messages_p90: number;
  messages_p95: number;
  prior_messages_p95: number;
  messages_max: number;
  prior_messages_max: number;
  /** Cache-inclusive tokens per session (input+output+cache+reasoning) — tokens processed. */
  tokens_p50: number;
  prior_tokens_p50: number;
  tokens_p90: number;
  prior_tokens_p90: number;
  tokens_p95: number;
  prior_tokens_p95: number;
  tokens_max: number;
  prior_tokens_max: number;
  total_messages: number;
  prior_total_messages: number;
  /** input+output+reasoning, excludes cache-read — tokens generated. */
  total_generated_tokens: number;
  prior_total_generated_tokens: number;
  total_cache_inclusive_tokens: number;
  prior_total_cache_inclusive_tokens: number;
  total_cost_usd: number;
  prior_total_cost_usd: number;
  /** Conversation-size histogram by message count (current window). */
  bin_1_2: number;
  prior_bin_1_2: number;
  bin_3_5: number;
  prior_bin_3_5: number;
  bin_6_10: number;
  prior_bin_6_10: number;
  bin_11_25: number;
  prior_bin_11_25: number;
  bin_26_50: number;
  prior_bin_26_50: number;
  bin_51_plus: number;
  prior_bin_51_plus: number;
  /** Size bands: small ≤5, medium 6–25, large ≥26 messages. */
  small_sessions: number;
  prior_small_sessions: number;
  medium_sessions: number;
  prior_medium_sessions: number;
  large_sessions: number;
  prior_large_sessions: number;
  small_cost_usd: number;
  medium_cost_usd: number;
  large_cost_usd: number;
}
