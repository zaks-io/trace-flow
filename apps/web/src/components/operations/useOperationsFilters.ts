import { useEffect, useMemo, useRef, useState } from 'react';
import { type TimeRange, TIME_RANGES } from '@/components/usage/types';
import { type LeaderboardSortKey } from '@/lib/operations';
import { snapToMinute } from '@/lib/tinybird';

export type { LeaderboardSortKey };

type OperationsFiltersState = {
  timeRange: TimeRange;
  setTimeRange: (v: TimeRange) => void;
  providerFilter: string;
  setProviderFilter: (v: string) => void;
  modelFilter: string;
  setModelFilter: (v: string) => void;
  operationFilter: string;
  setOperationFilter: (v: string) => void;
  selectedOperationName: string;
  setSelectedOperationName: (v: string) => void;
  apiKeyFilter: string;
  setApiKeyFilter: (v: string) => void;
  userIdFilter: string;
  setUserIdFilter: (v: string) => void;
  sortKey: LeaderboardSortKey;
  setSortKey: (v: LeaderboardSortKey) => void;
  sortDesc: boolean;
  setSortDesc: React.Dispatch<React.SetStateAction<boolean>>;
  filterParams: Record<string, string | number>;
  activeOperation: string;
  hasActiveFilters: boolean;
  clearFilters: () => void;
  seenProviders: React.MutableRefObject<Set<string>>;
  seenModels: React.MutableRefObject<Set<string>>;
  seenOperations: React.MutableRefObject<Set<string>>;
};

export function useOperationsFilters(): OperationsFiltersState {
  const [timeRange, setTimeRange] = useState<TimeRange>('30d');
  const [providerFilter, setProviderFilter] = useState('');
  const [modelFilter, setModelFilter] = useState('');
  const [operationFilter, setOperationFilter] = useState('');
  const [selectedOperationName, setSelectedOperationName] = useState('');
  const [apiKeyFilter, setApiKeyFilter] = useState('');
  const [userIdFilter, setUserIdFilter] = useState('');
  const [sortKey, setSortKey] = useState<LeaderboardSortKey>('total_cost_usd');
  const [sortDesc, setSortDesc] = useState(true);

  const trimmedUserId = userIdFilter.trim();
  const [debouncedUserId, setDebouncedUserId] = useState(trimmedUserId);

  useEffect(() => {
    const id = setTimeout(() => setDebouncedUserId(trimmedUserId), 300);
    return () => clearTimeout(id);
  }, [trimmedUserId]);

  const { startTimeNs, endTimeNs } = useMemo(() => {
    const rangeMs = TIME_RANGES.find((range) => range.value === timeRange)?.ms ?? 0;
    const now = Date.now();

    return {
      startTimeNs: snapToMinute(now - rangeMs) * 1_000_000,
      endTimeNs: snapToMinute(now) * 1_000_000,
    };
  }, [timeRange]);

  const filterParams = useMemo(() => {
    const params: Record<string, string | number> = {
      start_time_ns: startTimeNs,
      end_time_ns: endTimeNs,
    };

    if (providerFilter) params.provider = providerFilter;
    if (modelFilter) params.model = modelFilter;
    if (operationFilter) params.baggage_operation = operationFilter;
    if (apiKeyFilter) params.api_key_filter = apiKeyFilter;
    if (debouncedUserId) params.baggage_user_id = debouncedUserId;

    return params;
  }, [
    apiKeyFilter,
    endTimeNs,
    modelFilter,
    operationFilter,
    providerFilter,
    startTimeNs,
    debouncedUserId,
  ]);

  const seenProviders = useRef(new Set<string>());
  const seenModels = useRef(new Set<string>());
  const seenOperations = useRef(new Set<string>());
  const prevTimeRange = useRef(timeRange);

  if (prevTimeRange.current !== timeRange) {
    seenProviders.current.clear();
    seenModels.current.clear();
    seenOperations.current.clear();
    prevTimeRange.current = timeRange;
  }

  function clearFilters() {
    setProviderFilter('');
    setModelFilter('');
    setOperationFilter('');
    setSelectedOperationName('');
    setApiKeyFilter('');
    setUserIdFilter('');
  }

  const activeOperation = operationFilter || selectedOperationName;
  const hasActiveFilters = !!(
    providerFilter ||
    modelFilter ||
    operationFilter ||
    apiKeyFilter ||
    trimmedUserId
  );

  return {
    timeRange,
    setTimeRange,
    providerFilter,
    setProviderFilter,
    modelFilter,
    setModelFilter,
    operationFilter,
    setOperationFilter,
    selectedOperationName,
    setSelectedOperationName,
    apiKeyFilter,
    setApiKeyFilter,
    userIdFilter,
    setUserIdFilter,
    sortKey,
    setSortKey,
    sortDesc,
    setSortDesc,
    filterParams,
    activeOperation,
    hasActiveFilters,
    clearFilters,
    seenProviders,
    seenModels,
    seenOperations,
  };
}
