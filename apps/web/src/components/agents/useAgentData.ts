import { useMemo } from 'react';
import { useTinybirdQuery } from '@/hooks/useTinybirdQuery';
import type { TinybirdResponse } from '@/components/usage/types';
import type {
  AgentTimeseriesRow,
  CoverageRow,
  FailureLeaderboardRow,
  SessionOutlierRow,
  ToolDeltaRow,
} from './types';

type UseAgentDataParams = {
  filterParams: Record<string, string | number>;
};

export function useAgentData({ filterParams }: UseAgentDataParams) {
  const timeseriesQuery = useTinybirdQuery<TinybirdResponse<AgentTimeseriesRow>>({
    pipe: 'agent_usage_timeseries',
    params: filterParams,
  });

  const coverageQuery = useTinybirdQuery<TinybirdResponse<CoverageRow>>({
    pipe: 'agent_priced_coverage',
    params: filterParams,
  });

  const failuresQuery = useTinybirdQuery<TinybirdResponse<FailureLeaderboardRow>>({
    pipe: 'agent_failure_leaderboard',
    params: { ...filterParams, limit: 100 },
  });

  const deltaQuery = useTinybirdQuery<TinybirdResponse<ToolDeltaRow>>({
    pipe: 'agent_tool_period_delta',
    params: { ...filterParams, limit: 100 },
  });

  const outliersQuery = useTinybirdQuery<TinybirdResponse<SessionOutlierRow>>({
    pipe: 'agent_session_outliers',
    params: { ...filterParams, limit: 100 },
  });

  const coverage = coverageQuery.data?.data?.[0] ?? null;
  const timeseries = useMemo(() => timeseriesQuery.data?.data ?? [], [timeseriesQuery.data]);
  const failures = useMemo(() => failuresQuery.data?.data ?? [], [failuresQuery.data]);
  const deltas = useMemo(() => deltaQuery.data?.data ?? [], [deltaQuery.data]);
  const outliers = useMemo(() => outliersQuery.data?.data ?? [], [outliersQuery.data]);

  const isLoading =
    timeseriesQuery.isLoading ||
    coverageQuery.isLoading ||
    failuresQuery.isLoading ||
    deltaQuery.isLoading ||
    outliersQuery.isLoading;

  const hasError =
    timeseriesQuery.error ??
    coverageQuery.error ??
    failuresQuery.error ??
    deltaQuery.error ??
    outliersQuery.error;

  // Coverage counts every role in the window, so message_count === 0 is the
  // definitive "no agent activity" signal. A loaded coverage response with zero
  // messages (or, defensively, no aggregate row at all) means EMPTY regardless
  // of the other (also-empty) surfaces.
  const coverageLoaded = !isLoading && !hasError && coverageQuery.data != null;
  const isEmpty = coverageLoaded && (coverage == null || coverage.message_count === 0);

  // PARTIAL: some billable turns are unpriced (unpriced model or missing token
  // coverage), so the dollar figure is an estimate over a fraction of turns.
  const isPartial = coverage?.coverage_pct != null && coverage.coverage_pct < 1;

  return {
    timeseries,
    coverage,
    failures,
    deltas,
    outliers,
    isLoading,
    hasError,
    isEmpty,
    isPartial,
  };
}
