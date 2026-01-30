'use client';

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import { useTinybirdPipe } from '@/hooks/useTinybirdPipe';
import { useColumnVisibility } from '@/hooks/useColumnVisibility';
import { useTableFilters } from '@/hooks/useTableFilters';
import { useFilterOptions } from '@/hooks/useFilterOptions';
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

interface RequestsProps {
  traceId?: string;
  spanId?: string;
}

export default function Requests({ traceId: traceIdParam, spanId: spanIdParam }: RequestsProps) {
  usePageHeader('Requests');
  const router = useRouter();
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [isLiveMode, setIsLiveMode] = useState(true);
  const [alertFilter, setAlertFilter] = useState<AlertFilterValue>('all');
  const [mergedRequests, setMergedRequests] = useState<RequestRow[]>([]);
  const [initialLoadComplete, setInitialLoadComplete] = useState(false);
  const [latestReceivedAt, setLatestReceivedAt] = useState<number | null>(null);

  const isClosingRef = useRef(false);
  const lastProcessedDataRef = useRef<RequestRow[] | null>(null);
  const prevFiltersRef = useRef(JSON.stringify({}));

  const { visibility, setVisibility } = useColumnVisibility(defaultColumnVisibility);
  const { filters, setFilter, clearFilters, hasActiveFilters } = useTableFilters();
  const { options: filterOptions, loading: filterOptionsLoading } = useFilterOptions();
  const alerts = useQuery(api.alerts.listEnabled);

  // Compute pipe params - include after_received_at only after initial load in live mode
  const pipeParams = useMemo(() => {
    const params: Record<string, string | number | undefined> = { limit: 100 };
    if (filters.provider) params.provider = filters.provider;
    if (filters.model) params.model = filters.model;
    if (filters.status) params.status = filters.status;
    if (filters.search && /^[a-f0-9]+$/i.test(filters.search)) {
      params.search = filters.search; // Raw value, Pipe handles wildcards
    }
    if (isLiveMode && latestReceivedAt !== null) {
      params.after_received_at = latestReceivedAt;
    }
    return params;
  }, [filters, isLiveMode, latestReceivedAt]);

  const { data, loading, error } = useTinybirdPipe<TinybirdResponse>({
    pipe: 'traces_list',
    params: pipeParams,
    pollInterval: isLiveMode ? 10000 : undefined,
  });

  // Reset when filters change
  useEffect(() => {
    const currentFilters = JSON.stringify(filters);
    if (prevFiltersRef.current !== currentFilters) {
      prevFiltersRef.current = currentFilters;
      setInitialLoadComplete(false);
      setLatestReceivedAt(null);
      setMergedRequests([]);
      lastProcessedDataRef.current = data?.data ?? null; // Mark current data as seen
    }
  }, [filters]);

  // Handle initial load
  useEffect(() => {
    if (!initialLoadComplete && data?.data && data.data.length > 0) {
      if (lastProcessedDataRef.current === data.data) {
        return; // Skip stale data
      }
      setMergedRequests(data.data);
      setLatestReceivedAt(data.data[0].ReceivedAt);
      lastProcessedDataRef.current = data.data;
      setInitialLoadComplete(true);
    }
  }, [data, initialLoadComplete]);

  // Handle live mode merge
  useEffect(() => {
    if (!isLiveMode || !data?.data || !initialLoadComplete) return;
    if (data.data.length === 0) return;
    if (lastProcessedDataRef.current === data.data) return;

    lastProcessedDataRef.current = data.data;

    setMergedRequests((prev) => {
      // Deduplicate by TraceId-SpanId-ReceivedAt for proper uniqueness
      const seen = new Set(data.data.map((r) => `${r.TraceId}-${r.SpanId}-${r.ReceivedAt}`));
      const uniquePrev = prev.filter((r) => !seen.has(`${r.TraceId}-${r.SpanId}-${r.ReceivedAt}`));
      const merged = [...data.data, ...uniquePrev].slice(0, 100);
      if (merged.length > 0) {
        setLatestReceivedAt(merged[0].ReceivedAt);
      }
      return merged;
    });
  }, [data, isLiveMode, initialLoadComplete]);

  // Handle non-live mode - show raw data
  useEffect(() => {
    if (!isLiveMode && initialLoadComplete && data?.data) {
      setMergedRequests(data.data);
      if (data.data.length > 0) {
        setLatestReceivedAt(data.data[0].ReceivedAt);
      }
    }
  }, [isLiveMode, data, initialLoadComplete]);

  const requests = useMemo(
    () => (isLiveMode && initialLoadComplete ? mergedRequests : (data?.data ?? [])),
    [isLiveMode, initialLoadComplete, mergedRequests, data?.data],
  );
  const isLoading = loading && !initialLoadComplete;

  const handleRowClick = useCallback(
    (row: RequestRow, event: React.MouseEvent) => {
      // Extract requestId from SpanAttributes
      let requestId: string | undefined;
      try {
        const attrs = JSON.parse(row.SpanAttributes) as Record<string, string>;
        requestId = attrs['gen_ai.request_id'];
      } catch {
        // Ignore parse errors
      }

      if (event.metaKey || event.ctrlKey) {
        window.open(`/app/trace/${row.TraceId}`, '_blank');
      } else {
        isClosingRef.current = false;
        setSelectedTraceId(row.TraceId);
        setSelectedRequestId(requestId ?? null);
        setIsPanelOpen(true);
        router.replace(`/app/requests/${row.TraceId}/${row.SpanId}`);
      }
    },
    [router],
  );

  const handleClosePanel = useCallback(() => {
    isClosingRef.current = true;
    setIsPanelOpen(false);
    router.replace('/app/requests');
    setTimeout(() => {
      setSelectedTraceId(null);
      setSelectedRequestId(null);
      setTimeout(() => {
        isClosingRef.current = false;
      }, 100);
    }, 300);
  }, [router]);

  useEffect(() => {
    if (isClosingRef.current) {
      return;
    }

    if (traceIdParam && spanIdParam) {
      // Both parameters present - use exact match
      if (traceIdParam !== selectedTraceId || spanIdParam !== selectedSpanId) {
        isClosingRef.current = false;
        setSelectedTraceId(traceIdParam);
        setSelectedSpanId(spanIdParam);
        setIsPanelOpen(true);
      }
    } else if (traceIdParam && !spanIdParam) {
      // Backwards compatibility: if only traceId in URL, still open panel
      if (traceIdParam !== selectedTraceId) {
        isClosingRef.current = false;
        setSelectedTraceId(traceIdParam);
        setSelectedSpanId(null);
        setIsPanelOpen(true);
      }
    } else if (selectedTraceId && isPanelOpen) {
      setIsPanelOpen(false);
      setTimeout(() => {
        setSelectedTraceId(null);
        setSelectedSpanId(null);
      }, 300);
    }
  }, [traceIdParam, spanIdParam, selectedTraceId, selectedSpanId, isPanelOpen]);

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

  const alertSummary = useMemo(() => {
    if (!alerts || alerts.length === 0 || requests.length === 0) {
      return new Map();
    }
    return evaluateAlertsForTraces(requests, alerts);
  }, [requests, alerts]);

  const getRowId = useCallback(
    (row: RequestRow) => `${row.TraceId}-${row.SpanId}-${row.ReceivedAt}`,
    [],
  );

  const selectedRowId = useMemo(() => {
    if (!selectedTraceId) return null;

    // If we have both IDs, use exact match
    if (selectedSpanId) {
      const row = requests.find(
        (r) => r.TraceId === selectedTraceId && r.SpanId === selectedSpanId,
      );
      return row ? `${row.TraceId}-${row.SpanId}` : null;
    }

    // Fallback for backwards compatibility (traceId only)
    const row = requests.find((r) => r.TraceId === selectedTraceId);
    return row ? `${row.TraceId}-${row.SpanId}-${row.ReceivedAt}` : null;
  }, [selectedTraceId, requests]);

  if (isLoading && requests.length === 0) {
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
            </div>
          </div>
        </div>
      )}

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
        filters={filters}
        filterOptions={filterOptions}
        filterOptionsLoading={filterOptionsLoading}
        onFilterChange={setFilter}
        onClearFilters={clearFilters}
        hasActiveFilters={hasActiveFilters}
        loading={isLoading}
      />

      {selectedTraceId && (
        <TraceDetailPanel
          traceId={selectedTraceId}
          requestId={selectedRequestId ?? undefined}
          isOpen={isPanelOpen}
          onClose={handleClosePanel}
        />
      )}
    </div>
  );
}
