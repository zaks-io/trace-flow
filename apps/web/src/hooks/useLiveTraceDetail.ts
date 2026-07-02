'use client';

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAction } from 'convex/react';
import { api } from '@trace-flow/convex/_generated/api';
import { TraceSpanRowSchema } from '@trace-flow/spans';
import { fetchTinybirdPipe, tinybirdKeys } from '@/lib/tinybird';
import type { TraceSpan } from '@/lib/spans';

interface TinybirdResponse {
  data: TraceSpan[];
}

interface UseLiveTraceDetailOptions {
  traceId: string | null;
  enabled?: boolean;
}

interface UseLiveTraceDetailResult {
  spans: TraceSpan[];
  loading: boolean;
  error: Error | null;
  isLive: boolean;
}

const FIVE_MINUTES_NS = 5 * 60 * 1000 * 1_000_000;
const MIN_POLL_INTERVAL = 2000;
const MAX_POLL_INTERVAL = 30000;
const PIPE_NAME = 'trace_detail';

function shouldEnableLiveMode(spans: TraceSpan[]): boolean {
  if (spans.length === 0) return false;
  const maxTimestamp = spans.reduce((max, s) => (s.Timestamp > max ? s.Timestamp : max), -Infinity);
  const nowNs = Date.now() * 1_000_000;
  return nowNs - maxTimestamp < FIVE_MINUTES_NS;
}

function shouldStopLiveMode(lastSpanTimestamp: number): boolean {
  const nowNs = Date.now() * 1_000_000;
  return nowNs - lastSpanTimestamp >= FIVE_MINUTES_NS;
}

function mergeSpans(existing: TraceSpan[], incoming: TraceSpan[]): TraceSpan[] {
  if (incoming.length === 0) return existing;
  const existingIds = new Set(existing.map((s) => s.SpanId));
  const newSpans = incoming.filter((s) => !existingIds.has(s.SpanId));
  if (newSpans.length === 0) return existing;
  return [...existing, ...newSpans].sort((a, b) => a.Timestamp - b.Timestamp);
}

function calculateNextInterval(currentInterval: number, newSpansReceived: boolean): number {
  if (newSpansReceived) return MIN_POLL_INTERVAL;
  return Math.min(currentInterval * 2, MAX_POLL_INTERVAL);
}

export function useLiveTraceDetail(options: UseLiveTraceDetailOptions): UseLiveTraceDetailResult {
  const { traceId, enabled = true } = options;

  const [isLive, setIsLive] = useState(false);
  const pollIntervalRef = useRef(MIN_POLL_INTERVAL);
  const lastTimestampRef = useRef<number | null>(null);
  const isInitialFetchRef = useRef(true);

  const queryClient = useQueryClient();
  const generateWebReadToken = useAction(api.integrations.tinybird.generateWebReadToken);
  const prevTraceIdRef = useRef(traceId);

  const queryKey = useMemo(
    () => tinybirdKeys.pipeWithParams(PIPE_NAME, { trace_id: traceId ?? '' }),
    [traceId],
  );

  // Reset refs synchronously when traceId changes (before queryFn runs)
  if (prevTraceIdRef.current !== traceId) {
    prevTraceIdRef.current = traceId;
    isInitialFetchRef.current = true;
    lastTimestampRef.current = null;
    pollIntervalRef.current = MIN_POLL_INTERVAL;
  }

  const getRefetchInterval = useCallback((): number | false => {
    if (!isLive) return false;
    return pollIntervalRef.current;
  }, [isLive]);

  const query = useQuery({
    queryKey,
    queryFn: async (): Promise<TraceSpan[]> => {
      if (!traceId) return [];

      const isInitial = isInitialFetchRef.current;
      const sinceTimestamp = isInitial ? undefined : (lastTimestampRef.current ?? undefined);

      const params: Record<string, string | number> = { trace_id: traceId };
      if (sinceTimestamp !== undefined) {
        params.since_timestamp = sinceTimestamp;
      }

      const result = await fetchTinybirdPipe<TinybirdResponse>({
        pipe: PIPE_NAME,
        params,
        generateWebReadToken,
        schema: TraceSpanRowSchema,
      });

      const incoming = result.data;

      if (isInitial) {
        isInitialFetchRef.current = false;
        return incoming;
      }

      // Delta fetch: merge with existing cached spans.
      // Reading our own cache key here is intentional — react-query replaces
      // the cache entry with whatever queryFn returns, so we must read-then-merge
      // in a single pass. This is safe because queryFn is never called concurrently
      // for the same key, but be careful not to change queryKey without also
      // resetting isInitialFetchRef (done above via the traceId guard).
      const existing = queryClient.getQueryData<TraceSpan[]>(queryKey) ?? [];
      return mergeSpans(existing, incoming);
    },
    enabled: enabled && !!traceId,
    refetchInterval: getRefetchInterval,
    staleTime: 0,
    gcTime: 10 * 60 * 1000,
    retry: false,
  });

  const spans = useMemo(() => query.data ?? [], [query.data]);

  // Update live mode state and polling interval when data changes
  useEffect(() => {
    if (query.dataUpdatedAt === 0 || spans.length === 0) return;

    const maxTs = spans.reduce((max, s) => (s.Timestamp > max ? s.Timestamp : max), -Infinity);
    const prevTimestamp = lastTimestampRef.current;
    const hasNewSpans = prevTimestamp !== null && maxTs > prevTimestamp;

    lastTimestampRef.current = maxTs;

    if (shouldStopLiveMode(maxTs)) {
      setIsLive(false);
      return;
    }

    if (!isLive && shouldEnableLiveMode(spans)) {
      setIsLive(true);
      pollIntervalRef.current = MIN_POLL_INTERVAL;
      return;
    }

    if (isLive) {
      pollIntervalRef.current = calculateNextInterval(pollIntervalRef.current, hasNewSpans);
    }
  }, [query.dataUpdatedAt, spans, isLive]);

  // Reset live mode when traceId changes (refs are reset synchronously above)
  useEffect(() => {
    setIsLive(false);
  }, [traceId]);

  return {
    spans,
    loading: query.isLoading,
    error: query.error,
    isLive,
  };
}
