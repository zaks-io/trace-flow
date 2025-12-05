import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTinybirdQuery } from '@/hooks/useTinybirdQuery';
import { useColumnVisibility } from '@/hooks/useColumnVisibility';
import { DataTable } from '@/components/requests-table';
import {
  spanGroupColumns,
  defaultSpanGroupColumnVisibility,
  type SpanGroupRow,
} from '@/components/spans-table';

interface TinybirdResponse {
  data: SpanGroupRow[];
}

export default function Spans() {
  const navigate = useNavigate();
  const [isLiveMode, setIsLiveMode] = useState(true);
  const [mergedSpanGroups, setMergedSpanGroups] = useState<SpanGroupRow[]>([]);
  const [initialLoadComplete, setInitialLoadComplete] = useState(false);
  const [autoStoppedLiveMode, setAutoStoppedLiveMode] = useState(false);
  const [latestReceivedAt, setLatestReceivedAt] = useState<number | null>(null);

  const latestReceivedAtRef = useRef<number | null>(null);
  const prevLiveModeRef = useRef(false);
  const lastProcessedDataRef = useRef<SpanGroupRow[] | null>(null);

  const { visibility, setVisibility } = useColumnVisibility(
    defaultSpanGroupColumnVisibility,
    'trace-flow-span-groups-columns',
  );

  const sqlQuery = useMemo(() => {
    const baseQuery = `
      SELECT
        ParentSpanId,
        count() as ChildSpanCount,
        min(Timestamp) as FirstTimestamp,
        max(Timestamp) as LastTimestamp,
        max(ReceivedAt) as LatestReceivedAt,
        sum(Duration) as TotalDuration,
        avg(Duration) as AvgDuration,
        countIf(StatusCode = 'ERROR') as ErrorCount,
        groupArray(DISTINCT JSONExtractString(SpanAttributes, 'llm.model')) as Models
      FROM otel_traces
      WHERE ParentSpanId != '' AND SpanName = 'llm.request'`;

    if (isLiveMode && latestReceivedAt !== null) {
      return `${baseQuery} AND ReceivedAt > ${latestReceivedAt}
        GROUP BY ParentSpanId
        ORDER BY LatestReceivedAt DESC
        LIMIT 100
        FORMAT JSON`;
    }
    return `${baseQuery}
      GROUP BY ParentSpanId
      ORDER BY LatestReceivedAt DESC
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
    (row: SpanGroupRow, event: React.MouseEvent) => {
      if (event.metaKey || event.ctrlKey) {
        window.open(`/app/spans/${row.ParentSpanId}`, '_blank');
      } else {
        void navigate(`/spans/${row.ParentSpanId}`);
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
      const existingMap = new Map(prev.map((g) => [g.ParentSpanId, g]));

      for (const newGroup of data.data) {
        const existing = existingMap.get(newGroup.ParentSpanId);
        if (existing) {
          existingMap.set(newGroup.ParentSpanId, {
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
          });
        } else {
          existingMap.set(newGroup.ParentSpanId, newGroup);
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

  useEffect(() => {
    if (error && isLiveMode) {
      setAutoStoppedLiveMode(true);
      setIsLiveMode(false);
    } else if (!error) {
      setAutoStoppedLiveMode(false);
    }
  }, [error, isLiveMode]);

  const getRowId = useCallback((row: SpanGroupRow): string => String(row.ParentSpanId), []);

  if (loading && !initialLoadComplete) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          Loading span groups...
        </div>
      </div>
    );
  }

  return (
    <div className="animate-fade-in">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Spans</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Grouped requests by parent span ID. Click a row to view all requests in the group.
        </p>
      </div>

      {error && (
        <div className="mb-6 rounded-lg border border-destructive/50 bg-destructive/10 p-4">
          <div className="flex items-start justify-between">
            <div>
              <h3 className="mb-2 font-semibold text-destructive">Error loading span groups</h3>
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
          <p className="text-muted-foreground">No span groups found</p>
          <p className="mt-1 text-sm text-muted-foreground/70">
            Span groups will appear here when you send requests with the X-Trace-Flow-Span-Id header
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
        />
      )}
    </div>
  );
}
