import type { ChartConfig } from '@/components/ui/chart';

/** Source dimension filter; '' means all sources. */
export type AgentSource = '' | 'claude' | 'codex' | 'cursor';

export const AGENT_SOURCES: Exclude<AgentSource, ''>[] = ['claude', 'codex', 'cursor'];

/** Hero-chart metric switcher. Cost is the default and is always an estimate. */
export type AgentMetric = 'cost' | 'tokens' | 'messages' | 'sessions' | 'tool-events';

export const AGENT_METRICS: AgentMetric[] = [
  'cost',
  'tokens',
  'messages',
  'sessions',
  'tool-events',
];

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
