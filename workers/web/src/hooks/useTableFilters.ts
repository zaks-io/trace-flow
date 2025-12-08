import { useSearchParams } from 'react-router-dom';
import { useCallback, useMemo } from 'react';

export interface TableFilters {
  provider: string | null;
  model: string | null;
  status: string | null;
  search: string | null;
}

export interface UseTableFiltersResult {
  filters: TableFilters;
  setFilter: (key: keyof TableFilters, value: string | null) => void;
  clearFilters: () => void;
  hasActiveFilters: boolean;
}

const FILTER_KEYS: (keyof TableFilters)[] = ['provider', 'model', 'status', 'search'];

export function useTableFilters(): UseTableFiltersResult {
  const [searchParams, setSearchParams] = useSearchParams();

  const filters = useMemo((): TableFilters => {
    return {
      provider: searchParams.get('provider'),
      model: searchParams.get('model'),
      status: searchParams.get('status'),
      search: searchParams.get('search'),
    };
  }, [searchParams]);

  const setFilter = useCallback(
    (key: keyof TableFilters, value: string | null) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (value === null || value === '') {
            next.delete(key);
          } else {
            next.set(key, value);
          }
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const clearFilters = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const key of FILTER_KEYS) {
          next.delete(key);
        }
        return next;
      },
      { replace: true },
    );
  }, [setSearchParams]);

  const hasActiveFilters = useMemo(() => {
    return FILTER_KEYS.some((key) => filters[key] !== null);
  }, [filters]);

  return {
    filters,
    setFilter,
    clearFilters,
    hasActiveFilters,
  };
}
