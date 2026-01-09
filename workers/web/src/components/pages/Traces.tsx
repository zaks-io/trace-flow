import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import { useTinybirdPipe } from '@/hooks/useTinybirdPipe';
import { useColumnVisibility } from '@/hooks/useColumnVisibility';
import { usePageHeader } from '@/components/PageHeaderContext';
import { DataTable, type AlertFilterValue } from '@/components/requests-table';
import {
  spanGroupColumns,
  defaultSpanGroupColumnVisibility,
  type SpanGroupRow,
} from '@/components/spans-table';
import { evaluateAlertsForTraces } from '@/lib/alerts';
import type { RequestRow } from '@/components/requests-table/columns';

interface TinybirdResponse {
  data: SpanGroupRow[];
}

interface AlertSpansResponse {
  data: RequestRow[];
}

export default function Traces() {
  usePageHeader('Traces');
  const navigate = useNavigate();
  const [isLiveMode, setIsLiveMode] = useState(true);
  const [mergedSpanGroups, setMergedSpanGroups] = useState<SpanGroupRow[]>([]);
  const [initialLoadComplete, setInitialLoadComplete] = useState(false);
  const [autoStoppedLiveMode, setAutoStoppedLiveMode] = useState(false);
  const [latestReceivedAt, setLatestReceivedAt] = useState<number | null>(null);
  const [alertFilter, setAlertFilter] = useState<AlertFilterValue>('all');

  const latestReceivedAtRef = useRef<number | null>(null);
  const prevLiveModeRef = useRef(false);
  const lastProcessedDataRef = useRef<SpanGroupRow[] | null>(null);

  const alerts = useQuery(api.alerts.listEnabled);
  const { visibility, setVisibility } = useColumnVisibility(
    defaultSpanGroupColumnVisibility,
    'trace-flow-traces-columns',
  );

  // API key filtering is now handled server-side via JWT fixed_params
  const pipeParams = useMemo(() => {
    const params: Record<string, number | undefined> = {
      limit: 100,
    };
    if (isLiveMode && latestReceivedAt !== null) {
      params.after_received_at = latestReceivedAt;
    }
    return params;
  }, [isLiveMode, latestReceivedAt]);

  const { data, loading, error, refetch } = useTinybirdPipe<TinybirdResponse>({
    pipe: 'traces_grouped',
    params: pipeParams,
    pollInterval: isLiveMode ? 10000 : undefined,
  });

  const traceIds = useMemo(() => {
    const groups = isLiveMode && initialLoadComplete ? mergedSpanGroups : (data?.data ?? []);
    return groups.map((g) => g.TraceId);
  }, [isLiveMode, initialLoadComplete, mergedSpanGroups, data?.data]);

  // Fetch spans for alert evaluation using Pipe API
  const alertSpansParams = useMemo(() => {
    if (traceIds.length === 0 || !alerts || alerts.length === 0) return undefined;
    return { trace_ids: traceIds.join(',') };
  }, [traceIds, alerts]);

  const { data: alertSpansData } = useTinybirdPipe<AlertSpansResponse>({
    pipe: 'traces_for_alerts',
    params: alertSpansParams,
    enabled: alertSpansParams !== undefined,
  });

  const handleRowClick = useCallback(
    (row: SpanGroupRow, event: React.MouseEvent) => {
      if (event.metaKey || event.ctrlKey) {
        window.open(`/app/trace/${row.TraceId}`, '_blank');
      } else {
        void navigate(`/trace/${row.TraceId}`);
      }
    },
    [navigate],
  );

  useEffect(() => {
    if (!initialLoadComplete && data?.data && data.data.length > 0) {
      const groups = data.data;
      setMergedSpanGroups(groups);
      const newestReceivedAt = groups[0]!.LatestReceivedAt;
      latestReceivedAtRef.current = newestReceivedAt;
      setLatestReceivedAt(newestReceivedAt);
      lastProcessedDataRef.current = groups; // Mark this data as processed
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

    // Skip if this is the same data we already processed (prevents double-counting on initial load)
    if (lastProcessedDataRef.current === data.data) {
      return;
    }
    lastProcessedDataRef.current = data.data;

    setMergedSpanGroups((prev): SpanGroupRow[] => {
      const existingMap = new Map(prev.map((g) => [g.TraceId, g]));

      for (const newGroup of data.data) {
        const existing = existingMap.get(newGroup.TraceId);
        if (existing) {
          existingMap.set(newGroup.TraceId, {
            ...newGroup,
            ChildSpanCount: existing.ChildSpanCount + newGroup.ChildSpanCount,
            FirstTimestamp: Math.min(existing.FirstTimestamp, newGroup.FirstTimestamp),
            LastTimestamp: Math.max(existing.LastTimestamp, newGroup.LastTimestamp),
            TotalDuration: existing.TotalDuration + newGroup.TotalDuration,
            AvgDuration:
              (existing.TotalDuration + newGroup.TotalDuration) /
              (existing.ChildSpanCount + newGroup.ChildSpanCount),
            ErrorCount: existing.ErrorCount + newGroup.ErrorCount,
            Models: [...new Set([...existing.Models, ...newGroup.Models])],
            TotalCost: existing.TotalCost + newGroup.TotalCost,
          });
        } else {
          existingMap.set(newGroup.TraceId, newGroup);
        }
      }

      const merged = Array.from(existingMap.values()).sort(
        (a, b) => b.LatestReceivedAt - a.LatestReceivedAt,
      );

      if (merged.length > 0) {
        const newestReceivedAt = merged[0]!.LatestReceivedAt;
        latestReceivedAtRef.current = newestReceivedAt;
        setLatestReceivedAt(newestReceivedAt);
      }

      return merged.slice(0, 100);
    });
  }, [data, isLiveMode, initialLoadComplete]);

  useEffect(() => {
    if (!isLiveMode && initialLoadComplete && data?.data) {
      const groups = data.data;
      setMergedSpanGroups(groups);
      if (groups.length > 0) {
        const newestReceivedAt = groups[0]!.LatestReceivedAt;
        latestReceivedAtRef.current = newestReceivedAt;
        setLatestReceivedAt(newestReceivedAt);
      }
    }
  }, [isLiveMode, data, initialLoadComplete]);

  const spanGroups = useMemo(
    (): SpanGroupRow[] =>
      isLiveMode && initialLoadComplete ? mergedSpanGroups : (data?.data ?? []),
    [isLiveMode, initialLoadComplete, mergedSpanGroups, data?.data],
  );

  const alertSummary = useMemo(() => {
    if (!alerts || alerts.length === 0 || !alertSpansData?.data?.length) {
      return new Map();
    }
    return evaluateAlertsForTraces(alertSpansData.data, alerts);
  }, [alertSpansData, alerts]);

  useEffect(() => {
    if (error && isLiveMode) {
      setAutoStoppedLiveMode(true);
      setIsLiveMode(false);
    } else if (!error) {
      setAutoStoppedLiveMode(false);
    }
  }, [error, isLiveMode]);

  const getRowId = useCallback((row: SpanGroupRow): string => row.TraceId as string, []);

  if (loading && !initialLoadComplete) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          Loading traces...
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
              <h3 className="mb-2 font-semibold text-destructive">Error loading traces</h3>
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

      {spanGroups.length === 0 && !error ? (
        <div className="card-elevated rounded-xl border border-border bg-card p-12 text-center">
          <p className="text-muted-foreground">No traces found</p>
          <p className="mt-1 text-sm text-muted-foreground/70">
            Traces will appear here when you send requests through the gateway
          </p>
        </div>
      ) : (
        <DataTable
          columns={spanGroupColumns}
          data={spanGroups}
          columnVisibility={visibility}
          onColumnVisibilityChange={setVisibility}
          onRowClick={handleRowClick}
          getRowId={getRowId}
          isLiveMode={isLiveMode}
          onLiveModeToggle={() => setIsLiveMode(!isLiveMode)}
          alertSummary={alertSummary}
          alerts={alerts ?? []}
          alertFilter={alertFilter}
          onAlertFilterChange={setAlertFilter}
        />
      )}
    </div>
  );
}
