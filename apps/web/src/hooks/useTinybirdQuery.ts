'use client';

import { useQuery } from '@tanstack/react-query';
import { useAction } from 'convex/react';
import { api } from '@convex/_generated/api';
import { fetchTinybirdPipe, tinybirdKeys } from '@/lib/tinybird';

interface UseTinybirdQueryOptions<T> {
  pipe: string;
  params?: Record<string, string | number | boolean | undefined>;
  enabled?: boolean;
  pollInterval?: number;
  transform?: (data: unknown) => T;
  staleTime?: number;
  gcTime?: number;
}

export function useTinybirdQuery<T = unknown>(options: UseTinybirdQueryOptions<T>) {
  const { pipe, params, enabled = true, pollInterval, transform, staleTime, gcTime } = options;

  const generateWebReadToken = useAction(api.integrations.tinybird.generateWebReadToken);

  const query = useQuery({
    queryKey: tinybirdKeys.pipeWithParams(pipe, params as Record<string, unknown> | undefined),
    queryFn: () =>
      fetchTinybirdPipe<T>({
        pipe,
        params,
        transform,
        generateWebReadToken,
      }),
    enabled,
    refetchInterval: pollInterval ?? false,
    retry: false,
    staleTime,
    gcTime,
  });

  return {
    data: query.data ?? null,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
    refetch: query.refetch,
    dataUpdatedAt: query.dataUpdatedAt,
  };
}
