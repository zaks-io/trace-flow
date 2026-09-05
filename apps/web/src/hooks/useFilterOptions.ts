import { useMemo } from 'react';
import { useTinybirdQuery } from '@/hooks/useTinybirdQuery';
import { sortFilterOptions } from '@/lib/sortFilterOptions';

export interface FilterOptions {
  providers: string[];
  models: string[];
  statuses: string[];
  operations: string[];
}

interface UseFilterOptionsResult {
  options: FilterOptions;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

interface FilterOptionsRow {
  providers: string[];
  models: string[];
  statuses: string[];
  operations: string[];
}

export function useFilterOptions(): UseFilterOptionsResult {
  const { data, isLoading, error, refetch } = useTinybirdQuery<FilterOptionsRow>({
    pipe: 'filter_options',
  });

  const options: FilterOptions = useMemo(() => {
    const row = data?.data?.[0];
    return {
      providers: sortFilterOptions(row?.providers ?? []),
      models: sortFilterOptions(row?.models ?? []),
      statuses: sortFilterOptions(row?.statuses ?? []),
      operations: sortFilterOptions(row?.operations ?? []),
    };
  }, [data]);

  return { options, loading: isLoading, error, refetch };
}
