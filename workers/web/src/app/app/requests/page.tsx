'use client';

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTinybirdQuery } from '@/hooks/useTinybirdQuery';
import { useColumnVisibility } from '@/hooks/useColumnVisibility';
import { TraceDetailPanel } from '@/components/TraceDetailPanel';
import {
  DataTable,
  allColumns,
  defaultColumnVisibility,
  type RequestRow,
} from '@/components/requests-table';

interface TinybirdResponse {
  data: RequestRow[];
}

export default function Requests() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [isLiveMode, setIsLiveMode] = useState(true);
  const [mergedRequests, setMergedRequests] = useState<RequestRow[]>([]);
  const [initialLoadComplete, setInitialLoadComplete] = useState(false);
  const [autoStoppedLiveMode, setAutoStoppedLiveMode] = useState(false);
  const [latestReceivedAt, setLatestReceivedAt] = useState<number | null>(null);

  const latestReceivedAtRef = useRef<number | null>(null);
  const isClosingRef = useRef(false);
  const prevLiveModeRef = useRef(false);

  const { visibility, setVisibility } = useColumnVisibility(defaultColumnVisibility);

  const sqlQuery = useMemo(() => {
    if (isLiveMode && latestReceivedAt !== null) {
      return `SELECT ReceivedAt, Timestamp, TraceId, SpanId, SpanName, ServiceName, Duration, StatusCode, SpanAttributes
        FROM otel_traces
        WHERE ParentSpanId = '' AND ReceivedAt > ${latestReceivedAt}
        ORDER BY ReceivedAt DESC
        LIMIT 100
        FORMAT JSON`;
    }
    return `SELECT ReceivedAt, Timestamp, TraceId, SpanId, SpanName, ServiceName, Duration, StatusCode, SpanAttributes
      FROM otel_traces
      WHERE ParentSpanId = ''
      ORDER BY ReceivedAt DESC
      LIMIT 100
      FORMAT JSON`;
  }, [isLiveMode, latestReceivedAt]);

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

  const handleRowClick = useCallback(
    (row: RequestRow, event: React.MouseEvent) => {
      if (event.metaKey || event.ctrlKey) {
        window.open(`/app/request?id=${row.TraceId}`, '_blank');
      } else {
        isClosingRef.current = false;
        setSelectedTraceId(row.TraceId);
        setIsPanelOpen(true);
        const params = new URLSearchParams(searchParams.toString());
        params.set('id', row.TraceId);
        router.replace(`/app/requests?${params.toString()}`, { scroll: false });
      }
    },
    [searchParams, router],
  );

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
      const newestReceivedAt = requests[0]!.ReceivedAt;
      latestReceivedAtRef.current = newestReceivedAt;
      setLatestReceivedAt(newestReceivedAt);
      setInitialLoadComplete(true);
    }
  }, [data, initialLoadComplete]);

  useEffect(() => {
    if (
      isLiveMode &&
      !prevLiveModeRef.current &&
      latestReceivedAt !== null &&
      initialLoadComplete
    ) {
      void refetch();
    }
    prevLiveModeRef.current = isLiveMode;
  }, [isLiveMode, latestReceivedAt, initialLoadComplete, refetch]);

  useEffect(() => {
    if (!isLiveMode || !data?.data || !initialLoadComplete) {
      return;
    }

    if (data.data.length === 0) {
      return;
    }

    setMergedRequests((prev): RequestRow[] => {
      const existingKeys = new Set(prev.map((r) => `${r.TraceId}-${r.SpanId}`));

      const uniqueNewRequests = data.data.filter(
        (r) => !existingKeys.has(`${r.TraceId}-${r.SpanId}`),
      );

      if (uniqueNewRequests.length === 0) {
        return prev;
      }

      const merged: RequestRow[] = [...uniqueNewRequests, ...prev].sort(
        (a, b) => b.ReceivedAt - a.ReceivedAt,
      );

      if (merged.length > 0) {
        const newestReceivedAt = merged[0]!.ReceivedAt;
        latestReceivedAtRef.current = newestReceivedAt;
        setLatestReceivedAt(newestReceivedAt);
      }

      return merged.slice(0, 100);
    });
  }, [data, isLiveMode, initialLoadComplete]);

  useEffect(() => {
    if (!isLiveMode && initialLoadComplete && data?.data) {
      const requests = data.data;
      setMergedRequests(requests);
      if (requests.length > 0) {
        const newestReceivedAt = requests[0]!.ReceivedAt;
        latestReceivedAtRef.current = newestReceivedAt;
        setLatestReceivedAt(newestReceivedAt);
      }
    }
  }, [isLiveMode, data, initialLoadComplete]);

  const requests = useMemo(
    (): RequestRow[] => (isLiveMode && initialLoadComplete ? mergedRequests : (data?.data ?? [])),
    [isLiveMode, initialLoadComplete, mergedRequests, data?.data],
  );

  useEffect(() => {
    if (error && isLiveMode) {
      setAutoStoppedLiveMode(true);
      setIsLiveMode(false);
    } else if (!error) {
      setAutoStoppedLiveMode(false);
    }
  }, [error, isLiveMode]);

  const getRowId = useCallback((row: RequestRow) => `${row.TraceId}-${row.SpanId}`, []);

  const selectedRowId = useMemo(() => {
    if (!selectedTraceId) return null;
    const row = requests.find((r) => r.TraceId === selectedTraceId);
    return row ? `${row.TraceId}-${row.SpanId}` : null;
  }, [selectedTraceId, requests]);

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
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Requests</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Root traces from your requests. Click a row to view details in sidebar, or Cmd/Ctrl+click
          to open in a new tab.
        </p>
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
            Requests will appear here once your proxy receives traffic
          </p>
        </div>
      ) : (
        <DataTable
          columns={allColumns}
          data={requests}
          columnVisibility={visibility}
          onColumnVisibilityChange={setVisibility}
          onRowClick={handleRowClick}
          selectedRowId={selectedRowId}
          getRowId={getRowId}
          isLiveMode={isLiveMode}
          onLiveModeToggle={() => setIsLiveMode(!isLiveMode)}
        />
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
