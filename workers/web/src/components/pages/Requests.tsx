import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from 'convex/react';
import { api } from '../../../../../convex/_generated/api';
import { useRequestsQuery } from '@/hooks/useRequestsQuery';
import { useUserApiKeys } from '@/hooks/useUserApiKeys';
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

export default function Requests() {
  usePageHeader('Requests');
  const navigate = useNavigate();
  const { traceId: traceIdParam } = useParams<{ traceId?: string }>();
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [isLiveMode, setIsLiveMode] = useState(true);
  const [alertFilter, setAlertFilter] = useState<AlertFilterValue>('all');

  const isClosingRef = useRef(false);

  const { keys: userApiKeys, isLoading: keysLoading } = useUserApiKeys();
  const { visibility, setVisibility } = useColumnVisibility(defaultColumnVisibility);
  const { filters, setFilter, clearFilters, hasActiveFilters } = useTableFilters();
  const { options: filterOptions, loading: filterOptionsLoading } = useFilterOptions(userApiKeys);
  const alerts = useQuery(api.alerts.listEnabled);

  const {
    data: requests = [],
    isLoading,
    error,
  } = useRequestsQuery({
    filters,
    apiKeys: userApiKeys ?? [],
    isLiveMode,
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

  const alertSummary = useMemo(() => {
    if (!alerts || alerts.length === 0 || requests.length === 0) {
      return new Map();
    }
    return evaluateAlertsForTraces(requests, alerts);
  }, [requests, alerts]);

  const getRowId = useCallback((row: RequestRow) => `${row.TraceId}-${row.SpanId}`, []);

  const selectedRowId = useMemo(() => {
    if (!selectedTraceId) return null;
    const row = requests.find((r) => r.TraceId === selectedTraceId);
    return row ? `${row.TraceId}-${row.SpanId}` : null;
  }, [selectedTraceId, requests]);

  if ((isLoading || keysLoading) && requests.length === 0) {
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
          isOpen={isPanelOpen}
          onClose={handleClosePanel}
        />
      )}
    </div>
  );
}
