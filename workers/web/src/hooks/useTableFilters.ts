'use client';

import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { useCallback, useMemo } from 'react';

export interface TableFilters {
  provider: string | null;
  model: string | null;
  status: string | null;
  operation: string | null;
  search: string | null;
}

interface UseTableFiltersResult {
  filters: TableFilters;
  setFilter: (key: keyof TableFilters, value: string | null) => void;
  clearFilters: () => void;
  hasActiveFilters: boolean;
}

const FILTER_KEYS: (keyof TableFilters)[] = ['provider', 'model', 'status', 'operation', 'search'];

export function useTableFilters(): UseTableFiltersResult {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const filters = useMemo((): TableFilters => {
    return {
      provider: searchParams.get('provider'),
      model: searchParams.get('model'),
      status: searchParams.get('status'),
      operation: searchParams.get('operation'),
      search: searchParams.get('search'),
    };
  }, [searchParams]);

  const setFilter = useCallback(
    (key: keyof TableFilters, value: string | null) => {
      const next = new URLSearchParams(searchParams.toString());
      if (value === null || value === '') {
        next.delete(key);
      } else {
        next.set(key, value);
      }
      const queryString = next.toString();
      router.replace(queryString ? `${pathname}?${queryString}` : pathname);
    },
    [searchParams, router, pathname],
  );

  const clearFilters = useCallback(() => {
    const next = new URLSearchParams(searchParams.toString());
    for (const key of FILTER_KEYS) {
      next.delete(key);
    }
    const queryString = next.toString();
    router.replace(queryString ? `${pathname}?${queryString}` : pathname);
  }, [searchParams, router, pathname]);

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
