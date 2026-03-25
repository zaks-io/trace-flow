import { useMemo } from 'react';
import { useTinybirdQuery } from '@/hooks/useTinybirdQuery';

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

interface FilterOptionsResponse {
  data: {
    providers: string[];
    models: string[];
    statuses: string[];
    operations: string[];
  }[];
}

export function useFilterOptions(): UseFilterOptionsResult {
  const { data, isLoading, error, refetch } = useTinybirdQuery<FilterOptionsResponse>({
    pipe: 'filter_options',
    ttl: 600,
  });

  const options: FilterOptions = useMemo(() => {
    const row = data?.data?.[0];
    return {
      providers: row?.providers ?? [],
      models: row?.models ?? [],
      statuses: row?.statuses ?? [],
      operations: row?.operations ?? [],
    };
  }, [data]);

  return { options, loading: isLoading, error, refetch };
}
