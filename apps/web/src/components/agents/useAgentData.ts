import { useMemo } from 'react';
import { useTinybirdQuery } from '@/hooks/useTinybirdQuery';
import type { TinybirdResponse } from '@/components/usage/types';
import type {
  AgentGroupBy,
  AgentSummaryRow,
  AgentTimeseriesRow,
  FailureLeaderboardRow,
  ToolDeltaRow,
} from './types';

type UseAgentDataParams = {
  filterParams: Record<string, string | number>;
  /** group_by applies only to the time-series; the other surfaces ignore it. */
  groupBy: AgentGroupBy;
  /** Model IN-list; scopes the usage surfaces (time-series + summary) only — tool/session
   * pipes have no model dimension. */
  models: string[];
};

export function useAgentData({ filterParams, groupBy, models }: UseAgentDataParams) {
  // Tool events / sessions have no model, so models scopes only the usage surfaces.
  const usageParams = useMemo(
    () => (models.length > 0 ? { ...filterParams, models: models.join(',') } : filterParams),
    [filterParams, models],
  );

  const timeseriesParams = useMemo(
    () => (groupBy === 'none' ? usageParams : { ...usageParams, group_by: groupBy }),
    [usageParams, groupBy],
  );

  const timeseriesQuery = useTinybirdQuery<TinybirdResponse<AgentTimeseriesRow>>({
    pipe: 'agent_usage_timeseries',
    params: timeseriesParams,
  });

  const summaryQuery = useTinybirdQuery<TinybirdResponse<AgentSummaryRow>>({
    pipe: 'agent_usage_summary',
    params: usageParams,
  });

  const failuresQuery = useTinybirdQuery<TinybirdResponse<FailureLeaderboardRow>>({
    pipe: 'agent_failure_leaderboard',
    params: { ...filterParams, limit: 100 },
  });

  const deltaQuery = useTinybirdQuery<TinybirdResponse<ToolDeltaRow>>({
    pipe: 'agent_tool_period_delta',
    params: { ...filterParams, limit: 100 },
  });

  const summary = summaryQuery.data?.data?.[0] ?? null;
  const timeseries = useMemo(() => timeseriesQuery.data?.data ?? [], [timeseriesQuery.data]);
  const failures = useMemo(() => failuresQuery.data?.data ?? [], [failuresQuery.data]);
  const deltas = useMemo(() => deltaQuery.data?.data ?? [], [deltaQuery.data]);

  const isLoading =
    timeseriesQuery.isLoading ||
    summaryQuery.isLoading ||
    failuresQuery.isLoading ||
    deltaQuery.isLoading;

  const hasError =
    timeseriesQuery.error ?? summaryQuery.error ?? failuresQuery.error ?? deltaQuery.error;

  // The summary aggregates billable (assistant) turns over the window, so no billable
  // turns and no sessions is the "no agent activity" signal. A loaded summary response
  // with a null aggregate row (or all-zero counts) means EMPTY regardless of the other
  // (also-empty) surfaces.
  const summaryLoaded = !isLoading && !hasError && summaryQuery.data != null;
  const isEmpty =
    summaryLoaded &&
    (summary == null || (summary.message_count === 0 && summary.session_count === 0));

  // PARTIAL: some billable turns are unpriced (unpriced model or missing token
  // coverage), so the dollar figure is an estimate over a fraction of turns.
  const isPartial = summary?.coverage_pct != null && summary.coverage_pct < 1;

  return {
    timeseries,
    summary,
    failures,
    deltas,
    isLoading,
    hasError,
    isEmpty,
    isPartial,
  };
}
