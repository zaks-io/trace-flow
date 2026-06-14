import { useMemo } from 'react';
import { useTinybirdQuery } from '@/hooks/useTinybirdQuery';
import type { TinybirdResponse } from '@/components/usage/types';
import type {
  AgentContextHealthRow,
  AgentGranularity,
  AgentGroupBy,
  AgentSummaryRow,
  AgentTimeseriesRow,
  FailureLeaderboardRow,
  ToolDeltaRow,
} from './types';
import { buildContextHealthParams } from './contextHealth';

type UseAgentDataParams = {
  filterParams: Record<string, string | number>;
  /** group_by applies only to the time-series; the other surfaces ignore it. */
  groupBy: AgentGroupBy;
  /** Bucket size; passed only to the time-series (other surfaces are window totals). */
  granularity: AgentGranularity;
  /** Model IN-list; scopes message-grain usage/context surfaces only. */
  models: string[];
  attentionThresholdTokens: number;
};

export function useAgentData({
  filterParams,
  groupBy,
  granularity,
  models,
  attentionThresholdTokens,
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

  const timeseriesQuery = useTinybirdQuery<TinybirdResponse<AgentTimeseriesRow>>({
    pipe: 'agent_usage_timeseries',
    params: timeseriesParams,
  });

  const summaryQuery = useTinybirdQuery<TinybirdResponse<AgentSummaryRow>>({
    pipe: 'agent_usage_summary',
    params: usageParams,
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

  const summary = summaryQuery.data?.data?.[0] ?? null;
  const contextHealth = contextQuery.data?.data?.[0] ?? null;
  const timeseries = useMemo(() => timeseriesQuery.data?.data ?? [], [timeseriesQuery.data]);
  const failures = useMemo(() => failuresQuery.data?.data ?? [], [failuresQuery.data]);
  const deltas = useMemo(() => deltaQuery.data?.data ?? [], [deltaQuery.data]);

  const isLoading =
    timeseriesQuery.isLoading ||
    summaryQuery.isLoading ||
    contextQuery.isLoading ||
    failuresQuery.isLoading ||
    deltaQuery.isLoading;

  const hasError =
    timeseriesQuery.error ??
    summaryQuery.error ??
    contextQuery.error ??
    failuresQuery.error ??
    deltaQuery.error;

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
    summary,
    contextHealth,
    failures,
    deltas,
    isLoading,
    hasError,
    isEmpty,
    isPartial,
  };
}
