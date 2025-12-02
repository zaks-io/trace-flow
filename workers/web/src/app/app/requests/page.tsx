'use client';

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTinybirdQuery } from '@/hooks/useTinybirdQuery';
import { TraceDetailPanel } from '@/components/TraceDetailPanel';

interface RequestRow {
  Timestamp: number;
  TraceId: string;
  SpanId: string;
  SpanName: string;
  ServiceName: string;
  Duration: number;
  StatusCode: string;
}

interface TinybirdResponse {
  data: RequestRow[];
}

export default function Requests() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [isLiveMode, setIsLiveMode] = useState(false);
  const [mergedRequests, setMergedRequests] = useState<RequestRow[]>([]);
  const [initialLoadComplete, setInitialLoadComplete] = useState(false);
  const [autoStoppedLiveMode, setAutoStoppedLiveMode] = useState(false);
  const [latestTimestamp, setLatestTimestamp] = useState<number | null>(null);

  const latestTimestampRef = useRef<number | null>(null);
  const isClosingRef = useRef(false);
  const prevLiveModeRef = useRef(false);

  const sqlQuery = useMemo(() => {
    if (isLiveMode && latestTimestamp !== null) {
      return `SELECT Timestamp, TraceId, SpanId, SpanName, ServiceName, Duration, StatusCode
        FROM otel_traces
        WHERE ParentSpanId = '' AND Timestamp > ${latestTimestamp}
        ORDER BY Timestamp DESC
        LIMIT 100
        FORMAT JSON`;
    }
    return `SELECT Timestamp, TraceId, SpanId, SpanName, ServiceName, Duration, StatusCode
      FROM otel_traces
      WHERE ParentSpanId = ''
      ORDER BY Timestamp DESC
      LIMIT 100
      FORMAT JSON`;
  }, [isLiveMode, latestTimestamp]);

  const {
    data,
    loading,
    error,
    refetch,
  }: {
    data: TinybirdResponse | null;
    loading: boolean;
    error: Error | null;
    refetch: () => Promise<void>;
  } = useTinybirdQuery<TinybirdResponse>({
    sql: sqlQuery,
    scopes: [{ type: 'PIPES:READ', resource: 'otel_traces' }],
    pollInterval: isLiveMode ? 3000 : undefined,
  });

  const formatTimestamp = (nanoseconds: number) => {
    const milliseconds = nanoseconds / 1_000_000;
    return new Date(milliseconds).toLocaleString();
  };

  const formatDuration = (nanoseconds: number) => {
    const milliseconds = nanoseconds / 1_000_000;
    return `${milliseconds.toFixed(2)}ms`;
  };

  const truncateId = (id: string) => {
    return id.length > 16 ? `${id.slice(0, 16)}...` : id;
  };

  const handleRowClick = (traceId: string, event: React.MouseEvent) => {
    if (event.metaKey || event.ctrlKey) {
      window.open(`/app/request?id=${traceId}`, '_blank');
    } else {
      isClosingRef.current = false;
      setSelectedTraceId(traceId);
      setIsPanelOpen(true);
      const params = new URLSearchParams(searchParams.toString());
      params.set('id', traceId);
      router.replace(`/app/requests?${params.toString()}`, { scroll: false });
    }
  };

  const handleClosePanel = useCallback(() => {
    isClosingRef.current = true;
    setIsPanelOpen(false);
    const params = new URLSearchParams(searchParams.toString());
    params.delete('id');
    const newUrl = params.toString() ? `/app/requests?${params.toString()}` : '/app/requests';
    router.replace(newUrl, { scroll: false });
    setTimeout(() => {
      setSelectedTraceId(null);
      setTimeout(() => {
        isClosingRef.current = false;
      }, 100);
    }, 300);
  }, [searchParams, router]);

  useEffect(() => {
    if (isClosingRef.current) {
      return;
    }

    const traceIdFromUrl = searchParams.get('id');
    if (traceIdFromUrl) {
      if (traceIdFromUrl !== selectedTraceId) {
        isClosingRef.current = false;
        setSelectedTraceId(traceIdFromUrl);
        setIsPanelOpen(true);
      }
    } else if (selectedTraceId && isPanelOpen) {
      setIsPanelOpen(false);
      setTimeout(() => setSelectedTraceId(null), 300);
    }
  }, [searchParams, selectedTraceId, isPanelOpen]);

  useEffect(() => {
    if (!isPanelOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        handleClosePanel();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isPanelOpen, handleClosePanel]);

  useEffect(() => {
    if (!initialLoadComplete && data?.data && data.data.length > 0) {
      const requests = data.data;
      setMergedRequests(requests);
      const newestTimestamp = requests[0]!.Timestamp;
      latestTimestampRef.current = newestTimestamp;
      setLatestTimestamp(newestTimestamp);
      setInitialLoadComplete(true);
    }
  }, [data, initialLoadComplete]);

  useEffect(() => {
    if (isLiveMode && !prevLiveModeRef.current && latestTimestamp !== null && initialLoadComplete) {
      void refetch();
    }
    prevLiveModeRef.current = isLiveMode;
  }, [isLiveMode, latestTimestamp, initialLoadComplete, refetch]);

  useEffect(() => {
    if (!isLiveMode || !data?.data || !initialLoadComplete) {
      return;
    }

    if (data.data.length === 0) {
      return;
    }

    setMergedRequests((prev) => {
      const existingKeys = new Set(prev.map((r) => `${r.TraceId}-${r.SpanId}`));

      const uniqueNewRequests = data.data.filter(
        (r) => !existingKeys.has(`${r.TraceId}-${r.SpanId}`),
      );

      if (uniqueNewRequests.length === 0) {
        return prev;
      }

      const merged = [...uniqueNewRequests, ...prev].sort((a, b) => b.Timestamp - a.Timestamp);

      if (merged.length > 0) {
        const newestTimestamp = merged[0]!.Timestamp;
        latestTimestampRef.current = newestTimestamp;
        setLatestTimestamp(newestTimestamp);
      }

      return merged.slice(0, 100);
    });
  }, [data, isLiveMode, initialLoadComplete]);

  useEffect(() => {
    if (!isLiveMode && initialLoadComplete && data?.data) {
      const requests = data.data;
      setMergedRequests(requests);
      if (requests.length > 0) {
        const newestTimestamp = requests[0]!.Timestamp;
        latestTimestampRef.current = newestTimestamp;
        setLatestTimestamp(newestTimestamp);
      }
    }
  }, [isLiveMode, data, initialLoadComplete]);

  const requests = isLiveMode && initialLoadComplete ? mergedRequests : (data?.data ?? []);

  useEffect(() => {
    if (error && isLiveMode) {
      setAutoStoppedLiveMode(true);
      setIsLiveMode(false);
    } else if (!error) {
      setAutoStoppedLiveMode(false);
    }
  }, [error, isLiveMode]);

  if (loading && !initialLoadComplete) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          Loading requests...
        </div>
      </div>
    );
  }

  return (
    <div className="animate-fade-in">
      <div className="mb-8 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">LLM Requests</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Root traces from your LLM requests. Click a row to view details in sidebar, or
            Cmd/Ctrl+click to open in a new tab.
          </p>
        </div>
        <button
          onClick={() => setIsLiveMode(!isLiveMode)}
          className={`flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-all ${
            isLiveMode
              ? 'border-destructive/50 bg-destructive/10 text-destructive hover:bg-destructive/20'
              : 'border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground'
          }`}
        >
          <div className="flex items-center gap-2">
            {isLiveMode && (
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive opacity-75"></span>
                <span className="relative inline-flex h-2 w-2 rounded-full bg-destructive"></span>
              </span>
            )}
            <span>{isLiveMode ? 'LIVE' : 'Live Mode'}</span>
          </div>
        </button>
      </div>

      {error && (
        <div className="mb-6 rounded-lg border border-destructive/50 bg-destructive/10 p-4">
          <div className="flex items-start justify-between">
            <div>
              <h3 className="mb-2 font-semibold text-destructive">Error loading requests</h3>
              <p className="text-sm text-destructive/80">{error.message}</p>
              {autoStoppedLiveMode && (
                <p className="mt-2 text-sm text-destructive/80">
                  Live mode has been stopped due to the error.
                </p>
              )}
            </div>
            <button
              onClick={() => void refetch()}
              className="ml-4 rounded-lg bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground transition-colors hover:bg-destructive/90"
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {requests.length === 0 && !error ? (
        <div className="card-elevated rounded-xl border border-border bg-card p-12 text-center">
          <p className="text-muted-foreground">No requests found</p>
          <p className="mt-1 text-sm text-muted-foreground/70">
            Requests will appear here once your LLM proxy receives traffic
          </p>
        </div>
      ) : (
        <div className="card-elevated overflow-hidden rounded-xl border border-border bg-card">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-border">
              <thead className="bg-muted/30">
                <tr>
                  <th className="px-6 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Timestamp
                  </th>
                  <th className="px-6 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Trace ID
                  </th>
                  <th className="px-6 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Request Name
                  </th>
                  <th className="px-6 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Service
                  </th>
                  <th className="px-6 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Duration
                  </th>
                  <th className="px-6 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border bg-card">
                {requests.map((request) => (
                  <tr
                    key={`${request.TraceId}-${request.SpanId}`}
                    className="table-row-interactive cursor-pointer"
                    onClick={(e) => handleRowClick(request.TraceId, e)}
                  >
                    <td className="whitespace-nowrap px-6 py-4 text-sm text-foreground">
                      {formatTimestamp(request.Timestamp)}
                    </td>
                    <td
                      className="whitespace-nowrap px-6 py-4 text-sm text-muted-foreground"
                      title={request.TraceId}
                    >
                      <code className="rounded bg-muted/50 px-1.5 py-0.5 font-mono text-xs">
                        {truncateId(request.TraceId)}
                      </code>
                    </td>
                    <td className="whitespace-nowrap px-6 py-4 text-sm font-medium text-foreground">
                      {request.SpanName}
                    </td>
                    <td className="whitespace-nowrap px-6 py-4 text-sm text-muted-foreground">
                      {request.ServiceName}
                    </td>
                    <td className="whitespace-nowrap px-6 py-4 font-mono text-sm text-foreground">
                      {formatDuration(request.Duration)}
                    </td>
                    <td className="whitespace-nowrap px-6 py-4">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                          request.StatusCode === 'OK' || request.StatusCode === 'UNSET'
                            ? 'bg-emerald-500/20 text-emerald-400'
                            : request.StatusCode === 'ERROR'
                              ? 'bg-destructive/20 text-destructive'
                              : 'bg-muted text-muted-foreground'
                        }`}
                      >
                        {request.StatusCode}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="border-t border-border bg-muted/20 px-6 py-3">
            <p className="text-xs text-muted-foreground">
              Showing {requests.length} {requests.length === 1 ? 'request' : 'requests'}
            </p>
          </div>
        </div>
      )}

      {selectedTraceId && (
        <TraceDetailPanel
          traceId={selectedTraceId}
          isOpen={isPanelOpen}
          onClose={handleClosePanel}
        />
      )}
    </div>
  );
}
