'use client';

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { type Preloaded, usePreloadedQuery } from 'convex/react';
import { type api } from '@trace-flow/convex/_generated/api';
import { useTinybirdQuery } from '@/hooks/useTinybirdQuery';
import { useColumnVisibility } from '@/hooks/useColumnVisibility';
import { useTableFilters } from '@/hooks/useTableFilters';
import { useFilterOptions } from '@/hooks/useFilterOptions';
import { useApiKeyMap } from '@/hooks/useApiKeyMap';
import { useAnalyticsKeyFilter } from '@/hooks/useAnalyticsKeyFilter';
import { PageToolbar } from '@/components/shared/PageToolbar';
import { SetupCallout } from '@/components/onboarding/SetupCallout';
import type { ColumnDef } from '@tanstack/react-table';
import { DataTable, TableToolbar, type AlertFilterValue } from '@/components/requests/data-table';
import {
  spanGroupColumns,
  defaultSpanGroupColumnVisibility,
  type SpanGroupRow,
} from '@/components/traces/spans-table';
import { evaluateAlertsForTraces } from '@/lib/alerts';
import type { RequestRow } from '@/components/requests/data-table/columns';

interface TracesProps {
  preloadedAlerts: Preloaded<typeof api.alerts.listEnabled>;
  preloadedApiKeys: Preloaded<typeof api.apiKeys.listAnalytics>;
}

export default function Traces({ preloadedAlerts, preloadedApiKeys }: TracesProps) {
  const router = useRouter();
  const [isLiveMode, setIsLiveMode] = useState(true);
  const [mergedSpanGroups, setMergedSpanGroups] = useState<SpanGroupRow[]>([]);
  const [initialLoadComplete, setInitialLoadComplete] = useState(false);
  const [autoStoppedLiveMode, setAutoStoppedLiveMode] = useState(false);
  const [latestReceivedAt, setLatestReceivedAt] = useState<number | null>(null);
  const [alertFilter, setAlertFilter] = useState<AlertFilterValue>('all');

  const prevFiltersRef = useRef(JSON.stringify({}));
  const lastProcessedAtRef = useRef(0);

  const alerts = usePreloadedQuery(preloadedAlerts);
  const { visibility, setVisibility } = useColumnVisibility(
    defaultSpanGroupColumnVisibility,
    'trace-flow-traces-columns',
  );

  const { filters, setFilter, clearFilters, hasActiveFilters } = useTableFilters();
  const { options: filterOptions, loading: filterOptionsLoading } = useFilterOptions();
  const apiKeys = usePreloadedQuery(preloadedApiKeys);
  const apiKeyMap = useApiKeyMap(apiKeys);
  const apiKeyOptions = useMemo(() => Array.from(apiKeyMap.keys()), [apiKeyMap]);
  const { identifier: apiKeyFilter, error: apiKeyFilterError } = useAnalyticsKeyFilter(
    filters.apiKey,
  );

  useEffect(() => {
    if (filters.apiKey && apiKeyFilter && filters.apiKey !== apiKeyFilter) {
      setFilter('apiKey', apiKeyFilter);
    }
  }, [filters.apiKey, apiKeyFilter, setFilter]);

  const pipeParams = useMemo(() => {
    const params: Record<string, string | number | undefined> = {
      limit: 100,
    };
    if (filters.provider) params.provider = filters.provider;
    if (filters.model) params.model = filters.model;
    if (filters.status) params.status = filters.status;
    if (filters.operation) params.operation = filters.operation;
    if (filters.search && /^[a-f0-9]+$/i.test(filters.search)) {
      params.search = filters.search;
    }
    if (filters.apiKey) params.api_key_filter = apiKeyFilter ?? '__PENDING_ANALYTICS_KEY__';
    if (isLiveMode && latestReceivedAt !== null) {
      params.after_received_at = latestReceivedAt;
    }
    return params;
  }, [filters, isLiveMode, latestReceivedAt, apiKeyFilter]);

  const { data, isLoading, error, refetch, dataUpdatedAt } = useTinybirdQuery<SpanGroupRow>({
    pipe: 'traces_grouped',
    params: pipeParams,
    enabled: (!filters.apiKey || Boolean(apiKeyFilter)) && !apiKeyFilterError,
    pollInterval: isLiveMode ? 10000 : undefined,
    staleTime: 0,
  });
  const displayError = error ?? apiKeyFilterError;

  // Reset state when filters change
  useEffect(() => {
    const currentFilters = JSON.stringify(filters);
    if (prevFiltersRef.current !== currentFilters) {
      prevFiltersRef.current = currentFilters;
      setInitialLoadComplete(false);
      setLatestReceivedAt(null);
      setMergedSpanGroups([]);
      lastProcessedAtRef.current = 0;
    }
  }, [filters]);

  const traceIds = useMemo(() => {
    const groups = isLiveMode && initialLoadComplete ? mergedSpanGroups : (data?.data ?? []);
    return groups.map((g) => g.TraceId);
  }, [isLiveMode, initialLoadComplete, mergedSpanGroups, data?.data]);

  // Fetch spans for alert evaluation
  const alertSpansParams = useMemo(() => {
    if (traceIds.length === 0 || !alerts || alerts.length === 0) return undefined;
    return { trace_ids: traceIds.join(',') };
  }, [traceIds, alerts]);

  const { data: alertSpansData } = useTinybirdQuery<RequestRow>({
    pipe: 'traces_for_alerts',
    params: alertSpansParams,
    enabled: alertSpansParams !== undefined,
  });

  const handleRowClick = useCallback(
    (row: SpanGroupRow, event: React.MouseEvent) => {
      if (event.metaKey || event.ctrlKey) {
        window.open(`/app/trace/${row.TraceId}`, '_blank');
      } else {
        router.push(`/app/trace/${row.TraceId}`);
      }
    },
    [router],
  );

  // Handle data updates — initial load + live merge + non-live sync
  useEffect(() => {
    if (!data?.data || dataUpdatedAt === 0 || dataUpdatedAt === lastProcessedAtRef.current) return;
    lastProcessedAtRef.current = dataUpdatedAt;

    const groups = data.data;

    if (!initialLoadComplete) {
      if (groups.length > 0) {
        setMergedSpanGroups(groups);
        setLatestReceivedAt(groups[0]!.LatestReceivedAt);
      }
      setInitialLoadComplete(true);
      return;
    }

    if (!isLiveMode) {
      setMergedSpanGroups(groups);
      if (groups.length > 0) {
        setLatestReceivedAt(groups[0]!.LatestReceivedAt);
      }
      return;
    }

    // Live mode merge
    if (groups.length === 0) return;

    setMergedSpanGroups((prev): SpanGroupRow[] => {
      const existingMap = new Map(prev.map((g) => [g.TraceId, g]));

      for (const newGroup of groups) {
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
            Operations: [
              ...new Set([...(existing.Operations ?? []), ...(newGroup.Operations ?? [])]),
            ],
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
        setLatestReceivedAt(merged[0]!.LatestReceivedAt);
      }

      return merged.slice(0, 100);
    });
  }, [data, dataUpdatedAt, isLiveMode, initialLoadComplete]);

  const handleLiveModeToggle = useCallback(() => {
    const nextLiveMode = !isLiveMode;
    setIsLiveMode(nextLiveMode);
    if (nextLiveMode && initialLoadComplete) {
      void refetch();
    }
  }, [initialLoadComplete, isLiveMode, refetch]);

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
    if (displayError && isLiveMode) {
      setAutoStoppedLiveMode(true);
      setIsLiveMode(false);
    } else if (!displayError) {
      setAutoStoppedLiveMode(false);
    }
  }, [displayError, isLiveMode]);

  const getRowId = useCallback((row: SpanGroupRow): string => row.TraceId as string, []);

  const getRowClassName = useCallback(
    (row: SpanGroupRow) =>
      row.ErrorCount > 0 ? 'border-l-4 border-l-red-500/70' : 'border-l-4 border-l-transparent',
    [],
  );

  if (isLoading && !initialLoadComplete) {
    return (
      <>
        <PageToolbar />
        <div className="flex items-center justify-center py-12">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            Loading traces...
          </div>
        </div>
      </>
    );
  }

  return (
    <div className="animate-fade-in">
      <PageToolbar>
        <h1 className="text-sm font-medium text-foreground">Traces</h1>
      </PageToolbar>

      {displayError && (
        <div className="mb-4 rounded-lg border border-destructive/50 bg-destructive/10 p-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <p className="text-sm text-destructive">{displayError.message}</p>
              {autoStoppedLiveMode && (
                <span className="text-xs text-destructive/70">Live mode stopped.</span>
              )}
            </div>
            <button
              onClick={() => void refetch()}
              className="rounded-md bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground transition-colors hover:bg-destructive/90"
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {/* Sticky filter bar — horizontal negative margins extend it edge-to-edge */}
      <div className="sticky top-0 z-20 -mx-6 lg:-mx-8 px-6 lg:px-8 py-3 bg-background border-b border-border/50">
        <TableToolbar
          columnDefs={spanGroupColumns as ColumnDef<unknown>[]}
          columnVisibility={visibility}
          onColumnVisibilityChange={setVisibility}
          filters={filters}
          filterOptions={filterOptions}
          filterOptionsLoading={filterOptionsLoading}
          onFilterChange={setFilter}
          onClearFilters={clearFilters}
          hasActiveFilters={hasActiveFilters}
          alerts={alerts ?? []}
          alertFilter={alertFilter}
          onAlertFilterChange={setAlertFilter}
          isLiveMode={isLiveMode}
          onLiveModeToggle={handleLiveModeToggle}
          apiKeyOptions={apiKeyOptions}
          apiKeyMap={apiKeyMap}
        />
      </div>

      <div className="pt-4">
        <DataTable
          columns={spanGroupColumns}
          data={spanGroups}
          columnVisibility={visibility}
          onColumnVisibilityChange={setVisibility}
          onRowClick={handleRowClick}
          getRowId={getRowId}
          isLiveMode={isLiveMode}
          onLiveModeToggle={handleLiveModeToggle}
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
          emptyMessage={
            hasActiveFilters ? (
              'No traces found'
            ) : (
              <SetupCallout
                title="No traces yet"
                description="The trace timeline appears after your first real request reaches the Trace Flow gateway."
                primaryHref="/app"
                primaryLabel="Open getting started"
                secondaryHref="/docs/quick-start"
                secondaryLabel="Open quick start"
              />
            )
          }
          apiKeyOptions={apiKeyOptions}
          apiKeyMap={apiKeyMap}
          hideToolbar
          rowClassName={getRowClassName}
        />
      </div>
    </div>
  );
}
