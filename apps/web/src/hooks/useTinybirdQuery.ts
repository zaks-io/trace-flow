'use client';

import { useQuery } from '@tanstack/react-query';
import { useAction } from 'convex/react';
import { api } from '@trace-flow/convex/_generated/api';
import { fetchTinybirdPipe, tinybirdKeys, type TinybirdResponse } from '@/lib/tinybird';

interface UseTinybirdQueryOptions<T, TResult> {
  pipe: string;
  params?: Record<string, string | number | boolean | undefined>;
  enabled?: boolean;
  pollInterval?: number;
  transform?: (response: TinybirdResponse<T>) => TResult;
  staleTime?: number;
  gcTime?: number;
}

export function useTinybirdQuery<T = unknown, TResult = TinybirdResponse<T>>(
  options: UseTinybirdQueryOptions<T, TResult>,
) {
  const { pipe, params, enabled = true, pollInterval, transform, staleTime, gcTime } = options;

  const generateWebReadToken = useAction(api.integrations.tinybird.generateWebReadToken);

  const query = useQuery({
    queryKey: tinybirdKeys.pipeWithParams(pipe, params as Record<string, unknown> | undefined),
    queryFn: (): Promise<TinybirdResponse<T> | TResult> => {
      const request = { pipe, params, generateWebReadToken };
      return transform
        ? fetchTinybirdPipe<T, TResult>({ ...request, transform })
        : fetchTinybirdPipe<T>(request);
    },
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
