import { useMemo } from 'react';
import { useTinybirdQuery } from '@/hooks/useTinybirdQuery';
import type { TinybirdResponse } from '@/components/usage/types';
import type {
  AgentContextHealthRow,
  AgentCostDistributionRow,
  AgentGranularity,
  AgentGroupBy,
  AgentNotableChangeDimension,
  AgentNotableChangeRow,
  AgentSessionRow,
  AgentSummaryRow,
  AgentTimeseriesRow,
  FailureLeaderboardRow,
  ToolDeltaRow,
} from './types';
import { buildContextHealthParams } from './contextHealth';
import { buildPriorWindowParams } from './burnRate';

type UseAgentDataParams = {
  filterParams: Record<string, string | number>;
  /** group_by applies only to the time-series; the other surfaces ignore it. */
  groupBy: AgentGroupBy;
  /** Bucket size; passed only to the time-series (other surfaces are window totals). */
  granularity: AgentGranularity;
  /** Model IN-list; scopes message-grain usage/context surfaces only. */
  models: string[];
  attentionThresholdTokens: number;
  /** Gates the priciest-conversations fetch to the spend-concentration drill-down being open. */
  spendDetailEnabled: boolean;
};

/** How many priciest conversations the spend drill-down fetches (raw facts, no aggregation). */
const SPEND_DETAIL_LIMIT = 50;

type AgentDataFailure = {
  id: string;
  label: string;
  error: Error;
};

const EMPTY_ROWS: never[] = [];

type TinybirdQuerySnapshot<T> = {
  data: TinybirdResponse<T> | null;
  error: Error | null;
};

export function getFreshRows<T>(query: TinybirdQuerySnapshot<T>): T[] {
  if (query.error) return EMPTY_ROWS;
  return query.data?.data ?? EMPTY_ROWS;
}

export function getFreshFirstRow<T>(query: TinybirdQuerySnapshot<T>): T | null {
  return getFreshRows(query)[0] ?? null;
}

export function useAgentData({
  filterParams,
  groupBy,
  granularity,
  models,
  attentionThresholdTokens,
  spendDetailEnabled,
}: UseAgentDataParams) {
  const timezone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', []);

  // Tool events / sessions have no model, so models scopes only message-grain surfaces.
  const usageParams = useMemo(
    () => (models.length > 0 ? { ...filterParams, models: models.join(',') } : filterParams),
    [filterParams, models],
  );

  const timeseriesParams = useMemo(() => {
    const params: Record<string, string | number> = { ...usageParams };
    if (groupBy !== 'none') params.group_by = groupBy;
    if (granularity !== 'auto') params.granularity = granularity;
    params.timezone = timezone;
    return params;
  }, [usageParams, groupBy, granularity, timezone]);

  const burnSeriesParams = useMemo(
    () => ({ ...usageParams, granularity: 'day', timezone }),
    [usageParams, timezone],
  );

  const priorBurnSeriesParams = useMemo(
    () => ({ ...buildPriorWindowParams(usageParams), granularity: 'day', timezone }),
    [usageParams, timezone],
  );

  const timeseriesQuery = useTinybirdQuery<TinybirdResponse<AgentTimeseriesRow>>({
    pipe: 'agent_usage_timeseries',
    params: timeseriesParams,
  });

  const burnSeriesQuery = useTinybirdQuery<TinybirdResponse<AgentTimeseriesRow>>({
    pipe: 'agent_usage_timeseries',
    params: burnSeriesParams,
  });

  const priorBurnSeriesQuery = useTinybirdQuery<TinybirdResponse<AgentTimeseriesRow>>({
    pipe: 'agent_usage_timeseries',
    params: priorBurnSeriesParams,
  });

  const summaryQuery = useTinybirdQuery<TinybirdResponse<AgentSummaryRow>>({
    pipe: 'agent_usage_summary',
    params: usageParams,
  });

  const costDistributionQuery = useTinybirdQuery<TinybirdResponse<AgentCostDistributionRow>>({
    pipe: 'agent_session_cost_distribution',
    params: usageParams,
  });

  // Priciest conversations behind the spend-concentration curve. The browser pipe has no model
  // param, so it scopes by the source/window filters only; fetched only while the cell is open.
  const topSessionsParams = useMemo(
    () => ({ ...filterParams, sort: 'cost', limit: SPEND_DETAIL_LIMIT }),
    [filterParams],
  );

  const topSessionsQuery = useTinybirdQuery<TinybirdResponse<AgentSessionRow>>({
    pipe: 'agent_sessions_browser',
    params: topSessionsParams,
    enabled: spendDetailEnabled,
  });

  // Repos are the actionable mover unit; the dimension='' total row carries the org baseline.
  const notableByRepoParams = useMemo(
    () => ({ ...usageParams, dimension: 'repo' satisfies AgentNotableChangeDimension, limit: 50 }),
    [usageParams],
  );

  const notableTotalQuery = useTinybirdQuery<TinybirdResponse<AgentNotableChangeRow>>({
    pipe: 'agent_notable_changes',
    params: usageParams,
  });

  const notableByRepoQuery = useTinybirdQuery<TinybirdResponse<AgentNotableChangeRow>>({
    pipe: 'agent_notable_changes',
    params: notableByRepoParams,
  });

  const contextQuery = useTinybirdQuery<TinybirdResponse<AgentContextHealthRow>>({
    pipe: 'agent_context_health',
    params: buildContextHealthParams({
      filterParams,
      models,
      attentionThresholdTokens,
      limit: 1,
    }),
  });

  const failuresQuery = useTinybirdQuery<TinybirdResponse<FailureLeaderboardRow>>({
    pipe: 'agent_failure_leaderboard',
    params: { ...filterParams, limit: 100 },
  });

  const deltaQuery = useTinybirdQuery<TinybirdResponse<ToolDeltaRow>>({
    pipe: 'agent_tool_period_delta',
    params: { ...filterParams, limit: 100 },
  });

  const summary = getFreshFirstRow(summaryQuery);
  const costDistribution = getFreshFirstRow(costDistributionQuery);
  const topSessions = getFreshRows(topSessionsQuery);
  const notableTotal = getFreshFirstRow(notableTotalQuery);
  const notableByRepo = getFreshRows(notableByRepoQuery);
  const contextHealth = getFreshFirstRow(contextQuery);
  const timeseries = getFreshRows(timeseriesQuery);
  const burnSeries = getFreshRows(burnSeriesQuery);
  const priorBurnSeries = getFreshRows(priorBurnSeriesQuery);
  const failures = getFreshRows(failuresQuery);
  const deltas = getFreshRows(deltaQuery);

  const isLoading =
    timeseriesQuery.isLoading ||
    burnSeriesQuery.isLoading ||
    priorBurnSeriesQuery.isLoading ||
    summaryQuery.isLoading ||
    costDistributionQuery.isLoading ||
    notableTotalQuery.isLoading ||
    notableByRepoQuery.isLoading ||
    contextQuery.isLoading ||
    failuresQuery.isLoading ||
    deltaQuery.isLoading;

  const hasError =
    timeseriesQuery.error ??
    burnSeriesQuery.error ??
    priorBurnSeriesQuery.error ??
    summaryQuery.error ??
    costDistributionQuery.error ??
    notableTotalQuery.error ??
    notableByRepoQuery.error ??
    contextQuery.error ??
    failuresQuery.error ??
    deltaQuery.error;
  const failureCandidates: Array<{ id: string; label: string; error: Error | null }> = [
    { id: 'summary', label: 'summary cards', error: summaryQuery.error },
    { id: 'timeseries', label: 'chart', error: timeseriesQuery.error },
    {
      id: 'costDistribution',
      label: 'cost-per-conversation distribution',
      error: costDistributionQuery.error,
    },
    { id: 'notableTotal', label: 'notable changes (total)', error: notableTotalQuery.error },
    { id: 'notableByRepo', label: 'notable changes (by repo)', error: notableByRepoQuery.error },
    { id: 'burnSeries', label: 'burn rate', error: burnSeriesQuery.error },
    {
      id: 'priorBurnSeries',
      label: 'prior burn-rate comparison',
      error: priorBurnSeriesQuery.error,
    },
    { id: 'context', label: 'context health', error: contextQuery.error },
    { id: 'failures', label: 'tool failure leaderboard', error: failuresQuery.error },
    { id: 'deltas', label: 'tool period-over-period comparison', error: deltaQuery.error },
    { id: 'topSessions', label: 'priciest conversations', error: topSessionsQuery.error },
  ];
  const failedSurfaces: AgentDataFailure[] = failureCandidates.filter(
    (failure): failure is AgentDataFailure => failure.error instanceof Error,
  );

  // The summary aggregates billable (assistant) turns over the window, so no billable
  // turns and no sessions is the "no agent activity" signal. A loaded summary response
  // with a null aggregate row (or all-zero counts) means EMPTY regardless of the other
  // (also-empty) surfaces.
  const summaryLoaded = !summaryQuery.isLoading && !summaryQuery.error && summaryQuery.data != null;
  const isEmpty =
    summaryLoaded &&
    (summary == null || (summary.message_count === 0 && summary.session_count === 0));

  // PARTIAL: some billable turns are unpriced (unpriced model or missing token
  // coverage), so the dollar figure is an estimate over a fraction of turns.
  const isPartial = summary?.coverage_pct != null && summary.coverage_pct < 1;

  return {
    timeseries,
    burnSeries,
    priorBurnSeries,
    summary,
    costDistribution,
    topSessions,
    topSessionsLoading: topSessionsQuery.isLoading,
    notableTotal,
    notableByRepo,
    contextHealth,
    failures,
    deltas,
    isLoading,
    hasError,
    failedSurfaces,
    isEmpty,
    isPartial,
    timezone,
  };
}
