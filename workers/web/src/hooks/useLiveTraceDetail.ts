import { useState, useEffect, useRef, useCallback } from 'react';
import { useAction } from 'convex/react';
import { api } from '../../../../convex/_generated/api';

interface TraceSpan {
  ReceivedAt: number;
  Timestamp: number;
  TraceId: string;
  SpanId: string;
  ParentSpanId: string;
  SpanName: string;
  ServiceName: string;
  Duration: number;
  StatusCode: string;
  StatusMessage: string;
  SpanAttributes: string;
  ResourceAttributes: string;
  'Events.Timestamp': number[];
  'Events.Name': string[];
  'Events.Attributes': string[];
}

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
  const maxTimestamp = Math.max(...spans.map((s) => s.Timestamp));
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

  const [spans, setSpans] = useState<TraceSpan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [isLive, setIsLive] = useState(false);

  const jwtRef = useRef<string | null>(null);
  const pollIntervalRef = useRef(MIN_POLL_INTERVAL);
  const lastTimestampRef = useRef<number | null>(null);
  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);
  const isPollingRef = useRef(false);

  const generateToken = useAction(api.tinybird.generateToken);

  const fetchToken = useCallback(async (): Promise<string> => {
    const result = await generateToken({
      scopes: [{ type: 'PIPES:READ', resource: PIPE_NAME }],
    });
    jwtRef.current = result.token;
    return result.token;
  }, [generateToken]);

  const fetchSpans = useCallback(
    async (token: string, sinceTimestamp?: number): Promise<TraceSpan[]> => {
      const apiUrl = import.meta.env.NEXT_PUBLIC_TINYBIRD_API_URL ?? 'https://api.tinybird.co';
      const url = new URL(`${apiUrl}/v0/pipes/${PIPE_NAME}.json`);
      url.searchParams.set('trace_id', traceId!);
      if (sinceTimestamp !== undefined) {
        url.searchParams.set('since_timestamp', String(sinceTimestamp));
      }

      const response = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        const errorText = await response.text();
        if (response.status === 403) {
          jwtRef.current = null;
          throw new Error('AUTH_ERROR');
        }
        throw new Error(`Tinybird query failed: ${response.status} - ${errorText}`);
      }

      const result: TinybirdResponse = await response.json();
      return result.data;
    },
    [traceId],
  );

  const doInitialFetch = useCallback(async () => {
    if (!traceId || !enabled) return;

    setLoading(true);
    setError(null);

    try {
      const token = jwtRef.current ?? (await fetchToken());
      const data = await fetchSpans(token);

      if (!isMountedRef.current) return;

      setSpans(data);
      setLoading(false);

      if (data.length > 0) {
        const maxTs = Math.max(...data.map((s) => s.Timestamp));
        lastTimestampRef.current = maxTs;

        if (shouldEnableLiveMode(data)) {
          setIsLive(true);
        }
      }
    } catch (err) {
      if (!isMountedRef.current) return;

      if (err instanceof Error && err.message === 'AUTH_ERROR') {
        try {
          const freshToken = await fetchToken();
          const data = await fetchSpans(freshToken);
          if (!isMountedRef.current) return;
          setSpans(data);
          setLoading(false);
          if (data.length > 0) {
            const maxTs = Math.max(...data.map((s) => s.Timestamp));
            lastTimestampRef.current = maxTs;
            if (shouldEnableLiveMode(data)) {
              setIsLive(true);
            }
          }
          return;
        } catch (retryErr) {
          setError(retryErr instanceof Error ? retryErr : new Error(String(retryErr)));
          setLoading(false);
          return;
        }
      }

      setError(err instanceof Error ? err : new Error(String(err)));
      setLoading(false);
    }
  }, [traceId, enabled, fetchToken, fetchSpans]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setSpans([]);
    setLoading(true);
    setError(null);
    setIsLive(false);
    pollIntervalRef.current = MIN_POLL_INTERVAL;
    lastTimestampRef.current = null;

    if (pollTimeoutRef.current) {
      clearTimeout(pollTimeoutRef.current);
      pollTimeoutRef.current = null;
    }

    if (traceId && enabled) {
      void doInitialFetch();
    } else {
      setLoading(false);
    }
  }, [traceId, enabled, doInitialFetch]);

  useEffect(() => {
    if (!isLive || !traceId || loading || error) {
      return;
    }

    const poll = async () => {
      if (!isMountedRef.current || isPollingRef.current) return;

      isPollingRef.current = true;

      try {
        const token = jwtRef.current ?? (await fetchToken());
        const newSpansData = await fetchSpans(token, lastTimestampRef.current ?? undefined);

        if (!isMountedRef.current) {
          isPollingRef.current = false;
          return;
        }

        if (newSpansData.length > 0) {
          setSpans((prev) => mergeSpans(prev, newSpansData));
          const maxTs = Math.max(...newSpansData.map((s) => s.Timestamp));
          lastTimestampRef.current = maxTs;
          pollIntervalRef.current = calculateNextInterval(pollIntervalRef.current, true);
        } else {
          pollIntervalRef.current = calculateNextInterval(pollIntervalRef.current, false);
        }

        if (lastTimestampRef.current && shouldStopLiveMode(lastTimestampRef.current)) {
          setIsLive(false);
          isPollingRef.current = false;
          return;
        }

        pollTimeoutRef.current = setTimeout(() => void poll(), pollIntervalRef.current);
      } catch (err) {
        if (!isMountedRef.current) {
          isPollingRef.current = false;
          return;
        }

        if (err instanceof Error && err.message === 'AUTH_ERROR') {
          try {
            const freshToken = await fetchToken();
            const newSpansData = await fetchSpans(
              freshToken,
              lastTimestampRef.current ?? undefined,
            );
            if (!isMountedRef.current) {
              isPollingRef.current = false;
              return;
            }

            if (newSpansData.length > 0) {
              setSpans((prev) => mergeSpans(prev, newSpansData));
              const maxTs = Math.max(...newSpansData.map((s) => s.Timestamp));
              lastTimestampRef.current = maxTs;
              pollIntervalRef.current = calculateNextInterval(pollIntervalRef.current, true);
            } else {
              pollIntervalRef.current = calculateNextInterval(pollIntervalRef.current, false);
            }

            if (lastTimestampRef.current && shouldStopLiveMode(lastTimestampRef.current)) {
              setIsLive(false);
              isPollingRef.current = false;
              return;
            }

            pollTimeoutRef.current = setTimeout(() => void poll(), pollIntervalRef.current);
          } catch {
            pollTimeoutRef.current = setTimeout(() => void poll(), pollIntervalRef.current);
          }
        } else {
          pollTimeoutRef.current = setTimeout(() => void poll(), pollIntervalRef.current);
        }
      } finally {
        isPollingRef.current = false;
      }
    };

    pollTimeoutRef.current = setTimeout(() => void poll(), pollIntervalRef.current);

    return () => {
      if (pollTimeoutRef.current) {
        clearTimeout(pollTimeoutRef.current);
        pollTimeoutRef.current = null;
      }
    };
  }, [isLive, traceId, loading, error, fetchToken, fetchSpans]);

  return { spans, loading, error, isLive };
}
