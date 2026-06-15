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
  /** Per-TURN context percentiles (true weighted quantiles), NOT per-conversation. */
  context_p10: number;
  prior_context_p10: number;
  context_p50: number;
  prior_context_p50: number;
  context_p90: number;
  prior_context_p90: number;
  context_p95: number;
  prior_context_p95: number;
  context_max: number;
  prior_context_max: number;
  /** Count of individual turns whose context exceeded the threshold (the 140K signal). */
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
  /** The single conversation whose worst turn carried the most context (current window only). */
  worst_session_pk: string;
  worst_session_context_max: number;
  worst_session_calls_over_threshold: number;
  /**
   * Per-turn context histogram, 10 even 100K bins across the 0-1M ceiling (bin 9 = >=900K
   * catch-all). Bins are axis buckets, not thresholds — no headline metric derives from them.
   */
  context_hist_bin_0: number;
  context_hist_bin_1: number;
  context_hist_bin_2: number;
  context_hist_bin_3: number;
  context_hist_bin_4: number;
  context_hist_bin_5: number;
  context_hist_bin_6: number;
  context_hist_bin_7: number;
  context_hist_bin_8: number;
  context_hist_bin_9: number;
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
 * Single-row output of `pipes/agent_session_cost_distribution.pipe` — the per-conversation
 * COST and TOKEN distribution for the current window plus the prior equal-length window.
 * Messages are deliberately NOT a distribution axis here: cost and tokens are the only units
 * that matter. The pipe emits no row when both windows are empty (no sessions), so callers
 * treat a missing row as no-data.
 */
export interface AgentCostDistributionRow {
  session_count: number;
  prior_session_count: number;
  /** input+output+reasoning, excludes cache-read — tokens generated (the real work). */
  total_generated_tokens: number;
  prior_total_generated_tokens: number;
  /** +cache_read+cache_creation — tokens processed (mostly cache replay). */
  total_cache_inclusive_tokens: number;
  prior_total_cache_inclusive_tokens: number;
  total_cost_usd: number;
  prior_total_cost_usd: number;
  /** Per-conversation cost percentiles. The gap p50→p95 is the spend skew. */
  cost_p50: number;
  prior_cost_p50: number;
  cost_p90: number;
  prior_cost_p90: number;
  cost_p95: number;
  prior_cost_p95: number;
  cost_max: number;
  prior_cost_max: number;
  /** Per-conversation generated-token percentiles (default token axis). */
  generated_tokens_p50: number;
  prior_generated_tokens_p50: number;
  generated_tokens_p90: number;
  prior_generated_tokens_p90: number;
  generated_tokens_p95: number;
  prior_generated_tokens_p95: number;
  generated_tokens_max: number;
  prior_generated_tokens_max: number;
  /** Per-conversation cache-inclusive-token percentiles (tokens processed). */
  cache_inclusive_tokens_p50: number;
  prior_cache_inclusive_tokens_p50: number;
  cache_inclusive_tokens_p90: number;
  prior_cache_inclusive_tokens_p90: number;
  cache_inclusive_tokens_p95: number;
  prior_cache_inclusive_tokens_p95: number;
  cache_inclusive_tokens_max: number;
  prior_cache_inclusive_tokens_max: number;
  /** Cost-magnitude histogram: conversation counts per spend band (current window). */
  cost_bin_under_10c: number;
  cost_bin_10c_1: number;
  cost_bin_1_5: number;
  cost_bin_5_20: number;
  cost_bin_20_plus: number;
  /** Total spend within each cost band — shows where the dollars concentrate. */
  cost_sum_under_10c: number;
  cost_sum_10c_1: number;
  cost_sum_1_5: number;
  cost_sum_5_20: number;
  cost_sum_20_plus: number;
  /** Generated-token histogram: conversation counts per token band (current window). */
  token_bin_under_10k: number;
  token_bin_10k_50k: number;
  token_bin_50k_200k: number;
  token_bin_200k_1m: number;
  token_bin_1m_plus: number;
  token_sum_under_10k: number;
  token_sum_10k_50k: number;
  token_sum_50k_200k: number;
  token_sum_200k_1m: number;
  token_sum_1m_plus: number;
  /** Concentration: spend + count of the priciest 10% of conversations (the skew headline). */
  top_10pct_cost_usd: number;
  top_10pct_session_count: number;
  /**
   * Bin-free concentration (Lorenz) curve over the current window's per-conversation costs.
   * Every value below is derived from the sorted cost array — no chosen dollar or percentile
   * cutpoints. The curve sorts conversations priciest-first, so it bows ABOVE the diagonal.
   */
  /** Gini coefficient 0–1: 0 = spend even across all conversations, 1 = all in one. */
  gini: number;
  /** Smallest conversation count whose cumulative cost reaches half of total spend. */
  half_spend_conv_count: number;
  /** Cumulative conversation share (0–1) at each plotted point, priciest-first. */
  lorenz_conv_pct: number[];
  /** Cumulative spend share (0–1) at each plotted point; pairs with lorenz_conv_pct. */
  lorenz_cost_pct: number[];
}

/**
 * One row from `pipes/agent_sessions_browser.pipe` — a single browsable conversation. Powers
 * the spend-concentration drill-down (sort=cost). All facts are raw per-conversation values;
 * `repo_fingerprint` resolves to a name via the repo directory, falling back to a short hash.
 */
export interface AgentSessionRow {
  session_pk: string;
  source: string;
  model: string;
  repo_fingerprint: string;
  message_count: number;
  file_event_count: number;
  unique_file_count: number;
  /** Estimated cost (lower bound) for the conversation. */
  cost_usd: number;
  duration_ms: number;
  last_event_ms: number;
}

/**
 * One depth row from `pipes/agent_cost_by_depth.pipe` — how per-turn cost and context behave as a
 * conversation deepens. `depth` is the raw, 0-indexed `turn_index` (no binning, no chosen cutoff).
 * At each depth, every assistant turn at that position across EVERY conversation contributes, so the
 * bands are a population view, not a single conversation. The `*_elasticity` and `*_fit_points`
 * scalars are identical on every row (the same window-level fit), repeated for a flat row shape.
 */
export interface AgentCostByDepthRow {
  /** Raw conversation depth = turn_index (0-indexed chronological turn position). */
  depth: number;
  /** Conversations that reached this depth (main-thread turns only; sub-agent/sidechain excluded). */
  sample_count: number;
  /** Turns at this depth with a non-null cost (drives the cost band; context uses all turns). */
  priced_sample_count: number;
  /**
   * 1 when this depth has >= min_depth_samples conversations — enough to quantile and to enter the
   * fit. The chart plots only well-sampled depths so a sparse deep tail (1-2 conversations) can't
   * bury the trend. Self-scaling: shallow-only data clips early, genuinely deep data extends.
   */
  well_sampled: number;
  /** Per-turn COST band at this depth: p25–p75 is the body, p95 the envelope. */
  cost_p25: number;
  cost_p50: number;
  cost_p75: number;
  cost_p95: number;
  /** Per-turn CONTEXT band at this depth (input + cache read + cache write tokens). */
  context_p25: number;
  context_p50: number;
  context_p75: number;
  context_p95: number;
  /**
   * Log-log OLS slope of median per-turn cost on ln(depth+1) over depths with enough samples.
   * ~0 flat (a few large reads), ~1 linear bloat (history re-paid each turn), >1 accelerating
   * (the runaway/loop signal). Reads as "each doubling of depth multiplies per-turn cost by
   * 2^cost_elasticity". Derived by the fit, not a chosen threshold.
   */
  cost_elasticity: number;
  /** Same fit on context size (the upstream cause of the cost slope). */
  context_elasticity: number;
  /** Depths that entered the cost / context fit; <2 means no trend was estimable (slope = 0). */
  cost_fit_points: number;
  context_fit_points: number;
  /**
   * Window-level tail honesty (identical on every row). `charted_max_depth` is the deepest
   * well-sampled depth (the chart's x-extent); `observed_max_depth` is the true deepest turn seen
   * (reported even though it is not charted). `pooled_depth_count` / `pooled_turn_count` are how
   * many depths and turns fell below the threshold and were set aside, for an honest footnote.
   */
  charted_max_depth: number;
  observed_max_depth: number;
  pooled_depth_count: number;
  pooled_turn_count: number;
}

/**
 * One row from `pipes/agent_notable_changes.pipe` — honest period-over-period movement.
 * `group_value` is '' for the org-wide total; otherwise the source/model/repo value for the
 * requested `dimension`. Reports facts (deltas + daily pace vs a trailing-28d baseline), not
 * a statistical anomaly model — never labeled an "anomaly".
 */
export interface AgentNotableChangeRow {
  group_value: string;
  window_days: number;
  current_cost_usd: number;
  prior_cost_usd: number;
  cost_delta_usd: number;
  /** current_cost / window_days — the window's own daily pace. */
  current_daily_cost_usd: number;
  /** Trailing-28d total / 28 fixed days (idle days count as zero) — the longer-window norm. */
  baseline_daily_cost_usd: number;
  daily_cost_vs_baseline_usd: number;
  current_generated_tokens: number;
  prior_generated_tokens: number;
  generated_tokens_delta: number;
  /** Days in the trailing-28d baseline that had any spend; context for the baseline average. */
  baseline_active_days: number;
}

/** Dimensions the notable-changes pipe can rank movers by. */
export const AGENT_NOTABLE_CHANGE_DIMENSIONS = ['source', 'model', 'repo'] as const;
export type AgentNotableChangeDimension = (typeof AGENT_NOTABLE_CHANGE_DIMENSIONS)[number];
