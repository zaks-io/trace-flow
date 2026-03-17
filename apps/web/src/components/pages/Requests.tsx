'use client';

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { type Preloaded, usePreloadedQuery } from 'convex/react';
import { type api } from '@convex/_generated/api';
import { parseSpanAttributes } from '@trace-flow/utils';
import { useTinybirdQuery } from '@/hooks/useTinybirdQuery';
import { useColumnVisibility } from '@/hooks/useColumnVisibility';
import { useTableFilters } from '@/hooks/useTableFilters';
import { useFilterOptions } from '@/hooks/useFilterOptions';
import { useApiKeyMap } from '@/hooks/useApiKeyMap';
import { PageToolbar } from '@/components/PageToolbar';
import { SetupCallout } from '@/components/onboarding/SetupCallout';
import { RequestDetailSidePanel } from '@/components/RequestDetailSidePanel';
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

function getRequestId(row: RequestRow): string | undefined {
  return parseSpanAttributes(row.SpanAttributes)['gen_ai.request_id'];
}

interface RequestsProps {
  preloadedAlerts: Preloaded<typeof api.alerts.listEnabled>;
  preloadedApiKeys: Preloaded<typeof api.apiKeys.list>;
}

export default function Requests({ preloadedAlerts, preloadedApiKeys }: RequestsProps) {
  const [selectedRequest, setSelectedRequest] = useState<RequestRow | null>(null);
  const [isLiveMode, setIsLiveMode] = useState(true);
  const [autoStoppedLiveMode, setAutoStoppedLiveMode] = useState(false);
  const [alertFilter, setAlertFilter] = useState<AlertFilterValue>('all');
  const [mergedRequests, setMergedRequests] = useState<RequestRow[]>([]);
  const [initialLoadComplete, setInitialLoadComplete] = useState(false);
  const [latestReceivedAt, setLatestReceivedAt] = useState<number | null>(null);

  const lastProcessedAtRef = useRef(0);
  const prevFiltersRef = useRef(JSON.stringify({}));

  const { visibility, setVisibility } = useColumnVisibility(
    defaultColumnVisibility,
    'trace-flow-requests-columns-v2',
  );
  const { filters, setFilter, clearFilters, hasActiveFilters } = useTableFilters();
  const { options: filterOptions, loading: filterOptionsLoading } = useFilterOptions();
  const apiKeys = usePreloadedQuery(preloadedApiKeys);
  const apiKeyMap = useApiKeyMap(apiKeys);
  const alerts = usePreloadedQuery(preloadedAlerts);

  const pipeParams = useMemo(() => {
    const params: Record<string, string | number | undefined> = { limit: 100 };
    if (filters.provider) params.provider = filters.provider;
    if (filters.model) params.model = filters.model;
    if (filters.status) params.status = filters.status;
    if (filters.operation) params.operation = filters.operation;
    if (filters.search && /^[a-f0-9]+$/i.test(filters.search)) {
      params.search = filters.search;
    }
    if (filters.apiKey) params.api_key_filter = filters.apiKey;
    if (isLiveMode && latestReceivedAt !== null) {
      params.after_received_at = latestReceivedAt;
    }
    return params;
  }, [filters, isLiveMode, latestReceivedAt]);

  const { data, isLoading, error, refetch, dataUpdatedAt } = useTinybirdQuery<TinybirdResponse>({
    pipe: 'traces_list',
    params: pipeParams,
    pollInterval: isLiveMode ? 10000 : undefined,
    staleTime: 0,
  });

  // useEffect (not useLayoutEffect) is safe here because the data-processing
  // effect below guards on dataUpdatedAt, preventing stale data from rendering.
  useEffect(() => {
    const currentFilters = JSON.stringify(filters);
    if (prevFiltersRef.current !== currentFilters) {
      prevFiltersRef.current = currentFilters;
      setInitialLoadComplete(false);
      setLatestReceivedAt(null);
      setMergedRequests([]);
      lastProcessedAtRef.current = 0;
    }
  }, [filters]);

  // Handle data updates — initial load + live merge + non-live sync
  useEffect(() => {
    if (!data?.data || dataUpdatedAt === 0 || dataUpdatedAt === lastProcessedAtRef.current) return;
    lastProcessedAtRef.current = dataUpdatedAt;

    const rows = data.data;

    if (!initialLoadComplete) {
      if (rows.length > 0) {
        setMergedRequests(rows);
        setLatestReceivedAt(rows[0].ReceivedAt);
      }
      setInitialLoadComplete(true);
      return;
    }

    if (!isLiveMode) {
      setMergedRequests(rows);
      if (rows.length > 0) {
        setLatestReceivedAt(rows[0].ReceivedAt);
      }
      return;
    }

    // Live mode merge
    if (rows.length === 0) return;

    setMergedRequests((prev) => {
      const seen = new Set(rows.map((r) => `${r.TraceId}-${r.SpanId}-${r.ReceivedAt}`));
      const uniquePrev = prev.filter((r) => !seen.has(`${r.TraceId}-${r.SpanId}-${r.ReceivedAt}`));
      const merged = [...rows, ...uniquePrev].slice(0, 100);
      if (merged.length > 0) {
        setLatestReceivedAt(merged[0].ReceivedAt);
      }
      return merged;
    });
  }, [data, dataUpdatedAt, isLiveMode, initialLoadComplete]);

  const requests = useMemo(
    () => (isLiveMode && initialLoadComplete ? mergedRequests : (data?.data ?? [])),
    [isLiveMode, initialLoadComplete, mergedRequests, data?.data],
  );
  const loading = isLoading && !initialLoadComplete;

  const handleRowClick = useCallback((row: RequestRow, event: React.MouseEvent) => {
    if (event.metaKey || event.ctrlKey) {
      window.open(`/app/trace/${row.TraceId}`, '_blank');
    } else {
      setSelectedRequest(row);
    }
  }, []);

  const handleClosePanel = useCallback(() => {
    setSelectedRequest(null);
  }, []);

  const getRowId = useCallback((row: RequestRow) => getRequestId(row) ?? row.TraceId, []);

  const selectedRequestId = useMemo(() => {
    if (!selectedRequest) return null;
    return getRequestId(selectedRequest) ?? null;
  }, [selectedRequest]);

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

  if (loading && requests.length === 0) {
    return (
      <>
        <PageToolbar />
        <div className="flex items-center justify-center py-12">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            Loading requests...
          </div>
        </div>
      </>
    );
  }

  return (
    <div className="animate-fade-in">
      <PageToolbar>
        <h1 className="text-sm font-medium text-foreground">Requests</h1>
      </PageToolbar>

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

      <DataTable
        columns={allColumns}
        data={requests}
        columnVisibility={visibility}
        onColumnVisibilityChange={setVisibility}
        onRowClick={handleRowClick}
        selectedRowId={selectedRequestId}
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
        loading={loading}
        emptyMessage={
          hasActiveFilters ? (
            'No results found'
          ) : (
            <SetupCallout
              title="No requests yet"
              description="Send your first traced request from the getting started flow, then come back here to inspect individual calls."
              primaryHref="/app"
              primaryLabel="Open getting started"
              secondaryHref="/docs/quick-start"
              secondaryLabel="Open quick start"
            />
          )
        }
        apiKeyMap={apiKeyMap}
      />

      <RequestDetailSidePanel
        request={selectedRequest}
        isOpen={!!selectedRequest}
        onClose={handleClosePanel}
      />
    </div>
  );
}
