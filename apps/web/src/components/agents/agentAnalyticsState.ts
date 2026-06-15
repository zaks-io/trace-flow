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
