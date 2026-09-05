import { useMemo } from 'react';
import { useTinybirdQuery } from '@/hooks/useTinybirdQuery';
import {
  type OperationLeaderboardRow,
  type OperationUserRow,
  type ModelRow,
  type ProviderRow,
} from '@/components/usage/types';
import { getAggregateCacheHitRate, getLeaderboardSortValue } from '@/lib/operations';
import type { LeaderboardSortKey } from './useOperationsFilters';

type UseOperationsDataParams = {
  filterParams: Record<string, string | number>;
  activeOperation: string;
  sortKey: LeaderboardSortKey;
  sortDesc: boolean;
};

export function useOperationsData({
  filterParams,
  activeOperation,
  sortKey,
  sortDesc,
}: UseOperationsDataParams) {
  const operationsQuery = useTinybirdQuery<OperationLeaderboardRow>({
    pipe: 'operations_leaderboard',
    params: { ...filterParams, limit: 100 },
  });

  const usersQuery = useTinybirdQuery<OperationUserRow>({
    pipe: 'operation_user_breakdown',
    params: { ...filterParams, baggage_operation: activeOperation, limit: 50 },
    enabled: activeOperation !== '',
  });

  const providersQuery = useTinybirdQuery<ProviderRow>({
    pipe: 'llm_usage_by_provider',
    params: filterParams,
  });

  const modelsQuery = useTinybirdQuery<ModelRow>({
    pipe: 'llm_usage_by_model',
    params: filterParams,
  });

  const operations = useMemo(() => operationsQuery.data?.data ?? [], [operationsQuery.data]);
  const users = usersQuery.data?.data ?? [];
  const providers = useMemo(() => providersQuery.data?.data ?? [], [providersQuery.data]);
  const models = useMemo(() => modelsQuery.data?.data ?? [], [modelsQuery.data]);

  const isInitialLoading =
    operationsQuery.isLoading || providersQuery.isLoading || modelsQuery.isLoading;
  const isUsersLoading = usersQuery.isLoading;
  const hasError =
    operationsQuery.error ?? usersQuery.error ?? providersQuery.error ?? modelsQuery.error;

  const selectedOperation = operations.find((row) => row.operation === activeOperation) ?? null;

  const sortedOperations = useMemo(() => {
    return [...operations].sort((a, b) => {
      const aVal = getLeaderboardSortValue(a, sortKey);
      const bVal = getLeaderboardSortValue(b, sortKey);
      const adjustedA =
        sortKey === 'cache_hit_rate' && getAggregateCacheHitRate(a) == null ? -1 : aVal;
      const adjustedB =
        sortKey === 'cache_hit_rate' && getAggregateCacheHitRate(b) == null ? -1 : bVal;

      return sortDesc ? adjustedB - adjustedA : adjustedA - adjustedB;
    });
  }, [operations, sortKey, sortDesc]);

  return {
    operations,
    sortedOperations,
    users,
    providers,
    models,
    selectedOperation,
    isInitialLoading,
    isUsersLoading,
    hasError,
  };
}
