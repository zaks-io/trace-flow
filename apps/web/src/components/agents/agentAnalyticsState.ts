type LoadedAgentData = {
  summary: unknown | null;
  timeseries: readonly unknown[];
  contextHealth: unknown | null;
  failures: readonly unknown[];
  deltas: readonly unknown[];
};

type LoadedAgentDetailData = Omit<LoadedAgentData, 'summary'>;

export function hasLoadedAgentData({
  summary,
  timeseries,
  contextHealth,
  failures,
  deltas,
}: LoadedAgentData) {
  return (
    summary != null || hasLoadedAgentDetailData({ timeseries, contextHealth, failures, deltas })
  );
}

export function hasLoadedAgentDetailData({
  timeseries,
  contextHealth,
  failures,
  deltas,
}: LoadedAgentDetailData) {
  return timeseries.length > 0 || contextHealth != null || failures.length > 0 || deltas.length > 0;
}

export function shouldShowAgentEmptyState({
  isEmpty,
  hasError,
  hasLoadedData,
  hasLoadedDetailData,
}: {
  isEmpty: boolean;
  hasError: unknown;
  hasLoadedData: boolean;
  hasLoadedDetailData: boolean;
}) {
  return isEmpty && !hasLoadedDetailData && !(hasError && hasLoadedData);
}

type AgentMainView = 'loading' | 'error' | 'empty' | 'grid';

/**
 * The single source of truth for which top-level view `/app/agents` renders. The bento grid needs a
 * non-null summary, so when the summary FAILS (`summaryFailed`) the grid can't mount — but that is
 * not an empty workspace: other surfaces may have loaded and the toolbar already names the failure,
 * so we render `error` (banner only), never the misleading "No agent activity yet" empty state.
 */
export function resolveAgentMainView({
  isLoading,
  hasError,
  hasAnyLoadedData,
  shouldShowEmptyState,
  hasSummary,
  summaryFailed,
}: {
  isLoading: boolean;
  hasError: boolean;
  hasAnyLoadedData: boolean;
  shouldShowEmptyState: boolean;
  hasSummary: boolean;
  summaryFailed: boolean;
}): AgentMainView {
  if (isLoading) return 'loading';
  if ((hasError && !hasAnyLoadedData) || (summaryFailed && !hasSummary)) return 'error';
  if (shouldShowEmptyState || !hasSummary) return 'empty';
  return 'grid';
}
