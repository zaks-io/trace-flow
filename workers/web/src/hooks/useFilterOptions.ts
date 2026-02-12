import { useMemo } from 'react';
import { useTinybirdPipe } from '@/hooks/useTinybirdPipe';

export interface FilterOptions {
  providers: string[];
  models: string[];
  statuses: string[];
  operations: string[];
  apiKeys: string[];
}

interface UseFilterOptionsResult {
  options: FilterOptions;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

interface FilterOptionsResponse {
  data: {
    providers: string[];
    models: string[];
    statuses: string[];
    operations: string[];
    api_keys: string[];
  }[];
}

/**
 * Hook to fetch filter options using the filter_options Pipe.
 * API key filtering is handled server-side via JWT fixed_params.
 */
export function useFilterOptions(): UseFilterOptionsResult {
  const { data, loading, error, refetch } = useTinybirdPipe<FilterOptionsResponse>({
    pipe: 'filter_options',
    ttl: 600,
    transform: (result) => result as FilterOptionsResponse,
  });

  const options: FilterOptions = useMemo(() => {
    const row = data?.data?.[0];
    return {
      providers: row?.providers ?? [],
      models: row?.models ?? [],
      statuses: row?.statuses ?? [],
      operations: row?.operations ?? [],
      apiKeys: row?.api_keys ?? [],
    };
  }, [data]);

  return { options, loading, error, refetch };
}
