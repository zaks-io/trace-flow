'use client';

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import { parseSpanAttributes } from '@trace-flow/utils';
import { useTinybirdPipe } from '@/hooks/useTinybirdPipe';
import { useColumnVisibility } from '@/hooks/useColumnVisibility';
import { useTableFilters } from '@/hooks/useTableFilters';
import { useFilterOptions } from '@/hooks/useFilterOptions';
import { useApiKeyMap } from '@/hooks/useApiKeyMap';
import { usePageHeader } from '@/components/PageHeaderContext';
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

export default function Requests() {
  usePageHeader('Requests');
  const [selectedRequest, setSelectedRequest] = useState<RequestRow | null>(null);
  const [isLiveMode, setIsLiveMode] = useState(true);
  const [alertFilter, setAlertFilter] = useState<AlertFilterValue>('all');
  const [mergedRequests, setMergedRequests] = useState<RequestRow[]>([]);
  const [initialLoadComplete, setInitialLoadComplete] = useState(false);
  const [latestReceivedAt, setLatestReceivedAt] = useState<number | null>(null);

  const lastProcessedDataRef = useRef<RequestRow[] | null>(null);
  const prevFiltersRef = useRef(JSON.stringify({}));

  const { visibility, setVisibility } = useColumnVisibility(defaultColumnVisibility);
  const { filters, setFilter, clearFilters, hasActiveFilters } = useTableFilters();
  const { options: filterOptions, loading: filterOptionsLoading } = useFilterOptions();
  const apiKeyMap = useApiKeyMap();
  const alerts = useQuery(api.alerts.listEnabled);

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
      lastProcessedDataRef.current = data?.data ?? null;
    }
  }, [filters]);

  // Handle initial load
  useEffect(() => {
    if (!initialLoadComplete && data?.data && data.data.length > 0) {
      if (lastProcessedDataRef.current === data.data) {
        return;
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
        loading={isLoading}
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
