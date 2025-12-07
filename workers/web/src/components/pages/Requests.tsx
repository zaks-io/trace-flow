import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from 'convex/react';
import { api } from '../../../../../convex/_generated/api';
import { useTinybirdQuery } from '@/hooks/useTinybirdQuery';
import { useUserApiKeys } from '@/hooks/useUserApiKeys';
import { useColumnVisibility } from '@/hooks/useColumnVisibility';
import { usePageHeader } from '@/components/PageHeaderContext';
import { TraceDetailPanel } from '@/components/TraceDetailPanel';
import {
  DataTable,
  allColumns,
  defaultColumnVisibility,
  type RequestRow,
  type AlertFilterValue,
} from '@/components/requests-table';
import { evaluateAlertsForTraces } from '@/lib/alerts';

interface TinybirdResponse {
  data: RequestRow[];
}

export default function Requests() {
  usePageHeader('Requests');
  const navigate = useNavigate();
  const { traceId: traceIdParam } = useParams<{ traceId?: string }>();
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [isLiveMode, setIsLiveMode] = useState(true);
  const [mergedRequests, setMergedRequests] = useState<RequestRow[]>([]);
  const [initialLoadComplete, setInitialLoadComplete] = useState(false);
  const [autoStoppedLiveMode, setAutoStoppedLiveMode] = useState(false);
  const [latestReceivedAt, setLatestReceivedAt] = useState<number | null>(null);
  const [alertFilter, setAlertFilter] = useState<AlertFilterValue>('all');

  const latestReceivedAtRef = useRef<number | null>(null);
  const isClosingRef = useRef(false);
  const prevLiveModeRef = useRef(false);

  const { keys: userApiKeys, isLoading: keysLoading } = useUserApiKeys();
  const { visibility, setVisibility } = useColumnVisibility(defaultColumnVisibility);
  const alerts = useQuery(api.alerts.listEnabled);

  const sqlQuery = useMemo(() => {
    if (isLiveMode && latestReceivedAt !== null) {
      return `SELECT ReceivedAt, Timestamp, TraceId, SpanId, SpanName, ServiceName, Duration, StatusCode, SpanAttributes
        FROM otel_traces
        WHERE SpanName = 'ai.request' AND ReceivedAt > ${latestReceivedAt}
        ORDER BY ReceivedAt DESC
        LIMIT 100
        FORMAT JSON`;
    }
    return `SELECT ReceivedAt, Timestamp, TraceId, SpanId, SpanName, ServiceName, Duration, StatusCode, SpanAttributes
      FROM otel_traces
      WHERE SpanName = 'ai.request'
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
    apiKeys: userApiKeys,
  });

  const handleRowClick = useCallback(
    (row: RequestRow, event: React.MouseEvent) => {
      if (event.metaKey || event.ctrlKey) {
        window.open(`/app/trace/${row.TraceId}`, '_blank');
      } else {
        isClosingRef.current = false;
        setSelectedTraceId(row.TraceId);
        setIsPanelOpen(true);
        void navigate(`/requests/${row.TraceId}`, { replace: true });
      }
    },
    [navigate],
  );

  const handleClosePanel = useCallback(() => {
    isClosingRef.current = true;
    setIsPanelOpen(false);
    void navigate('/requests', { replace: true });
    setTimeout(() => {
      setSelectedTraceId(null);
      setTimeout(() => {
        isClosingRef.current = false;
      }, 100);
    }, 300);
  }, [navigate]);

  useEffect(() => {
    if (isClosingRef.current) {
      return;
    }

    if (traceIdParam) {
      if (traceIdParam !== selectedTraceId) {
        isClosingRef.current = false;
        setSelectedTraceId(traceIdParam);
        setIsPanelOpen(true);
      }
    } else if (selectedTraceId && isPanelOpen) {
      setIsPanelOpen(false);
      setTimeout(() => setSelectedTraceId(null), 300);
    }
  }, [traceIdParam, selectedTraceId, isPanelOpen]);

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

  const alertSummary = useMemo(() => {
    if (!alerts || alerts.length === 0 || requests.length === 0) {
      return new Map();
    }
    return evaluateAlertsForTraces(requests, alerts);
  }, [requests, alerts]);

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

  if ((loading || keysLoading) && !initialLoadComplete) {
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
          alertSummary={alertSummary}
          alerts={alerts ?? []}
          alertFilter={alertFilter}
          onAlertFilterChange={setAlertFilter}
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
