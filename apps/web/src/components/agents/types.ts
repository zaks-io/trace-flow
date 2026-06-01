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

export const AGENT_GRANULARITIES: AgentGranularity[] = ['auto', 'hour', 'day'];

export const AGENT_GRANULARITY_LABEL: Record<AgentGranularity, string> = {
  auto: 'Auto',
  hour: 'Hourly',
  day: 'Daily',
};

/** Single-row output of `pipes/agent_usage_summary.pipe` — current window + prior period. */
export interface AgentSummaryRow {
  /** Estimated Agent Session Authoring Cost for the window; sums priced rows only. */
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
  /** Estimated Agent Session Authoring Cost; sums priced rows only. */
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

export const AGENT_METRIC_LABEL: Record<AgentMetric, string> = {
  cost: 'Cost',
  tokens: 'Tokens',
  messages: 'Messages',
  sessions: 'Sessions',
  'tool-events': 'Tool Events',
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

/** One row from `pipes/agent_usage_breakdown.pipe` (ranked aggregates by a dimension). */
export interface AgentBreakdownRow {
  group_value: string;
  message_count: number;
  session_count: number;
  total_tokens: number;
  cost_usd: number;
}

/**
 * The AgentBreakdownRow column each metric ranks/displays by. The breakdown has no tool
 * grain, so the tool-events metric falls back to message_count.
 */
export const AGENT_BREAKDOWN_METRIC_KEY: Record<AgentMetric, keyof AgentBreakdownRow> = {
  cost: 'cost_usd',
  tokens: 'total_tokens',
  messages: 'message_count',
  sessions: 'session_count',
  'tool-events': 'message_count',
};

/** The group-by dimensions that get a breakdown panel (None has no breakdown). */
export const AGENT_BREAKDOWN_DIMENSIONS = ['source', 'model', 'repo'] as const;
export type AgentBreakdownDimension = (typeof AGENT_BREAKDOWN_DIMENSIONS)[number];

/** Sort key for the browsable Agent Session table (all descending). */
export type AgentSessionSort = 'recent' | 'cost' | 'files' | 'duration' | 'messages';

export const AGENT_SESSION_PAGE_SIZE = 25;

/** One row from `pipes/agent_sessions_browser.pipe`. */
export interface AgentSessionRow {
  session_pk: string;
  source: string;
  model: string;
  repo_fingerprint: string;
  message_count: number;
  file_event_count: number;
  unique_file_count: number;
  /** Estimated cost; null when every message in the session is unpriced. */
  cost_usd: number | null;
  duration_ms: number;
  last_event_ms: number;
}

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
