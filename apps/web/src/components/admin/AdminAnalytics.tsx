'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAction } from 'convex/react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@trace-flow/convex/_generated/api';
import { useIsAdmin } from '@/components/admin/AdminContext';
import { PageToolbar } from '@/components/shared/PageToolbar';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useColumnVisibility } from '@/hooks/useColumnVisibility';
import { AnalyticsFilterBar } from './analytics/AnalyticsFilterBar';
import { BreakdownsPanel } from './analytics/BreakdownsPanel';
import { DashboardSummary } from './analytics/DashboardSummary';
import { ExplorerPanel } from './analytics/ExplorerPanel';
import { ExplorerRowDialog } from './analytics/ExplorerRowDialog';
import { LoadingState } from './analytics/LoadingState';
import { SectionError } from './analytics/SectionError';
import { SqlRunnerPanel } from './analytics/SqlRunnerPanel';
import { explorerColumns, explorerDefaultVisibility, TIME_RANGES } from './analytics/constants';
import { downloadText } from './analytics/format';
import { buildDefaultQuery } from './analytics/presetQueries';
import type {
  BreakdownDimension,
  ChartMetric,
  DashboardData,
  ExplorerResponse,
  ExplorerRow,
  FiltersState,
  QueryRunnerResult,
  TimeRangeValue,
} from './analytics/types';

export default function AdminAnalytics() {
  const isAdmin = useIsAdmin();
  const getDashboard = useAction(api.admin.adminAnalytics.getDashboard);
  const getExplorerRows = useAction(api.admin.adminAnalytics.getExplorerRows);
  const runAdvancedQuery = useAction(api.admin.adminAnalytics.runAdvancedQuery);
  const exportExplorerCsv = useAction(api.admin.adminAnalytics.exportExplorerCsv);

  const [timeRange, setTimeRange] = useState<TimeRangeValue>('24h');
  const [filters, setFilters] = useState<FiltersState>({
    orgId: '',
    provider: '',
    statusCode: '',
    operation: '',
    skipReason: '',
    isSse: '',
    model: '',
  });
  const [chartMetric, setChartMetric] = useState<ChartMetric>('requestCount');
  const [breakdownDimension, setBreakdownDimension] = useState<BreakdownDimension>('provider');
  const [breakdownSearch, setBreakdownSearch] = useState('');
  const [explorerSearch, setExplorerSearch] = useState('');
  const [explorerOffset, setExplorerOffset] = useState(0);
  const [selectedRow, setSelectedRow] = useState<ExplorerRow | null>(null);
  const [runnerSql, setRunnerSql] = useState('');
  const [runnerResult, setRunnerResult] = useState<QueryRunnerResult | null>(null);
  const [runnerError, setRunnerError] = useState('');
  const [runnerPending, setRunnerPending] = useState(false);
  const [exportError, setExportError] = useState('');
  const [exportPending, setExportPending] = useState(false);

  const { visibility, setVisibility } = useColumnVisibility(
    explorerDefaultVisibility,
    'trace-flow-admin-ae-explorer-columns-v1',
  );

  const timeWindow = useMemo(() => {
    const range = TIME_RANGES.find((entry) => entry.value === timeRange) ?? TIME_RANGES[0];
    const endTimeMs = Date.now();
    return {
      startTimeMs: endTimeMs - range.ms,
      endTimeMs,
    };
  }, [timeRange]);

  const queryFilters = useMemo(
    () => ({
      ...timeWindow,
      orgId: filters.orgId || undefined,
      provider: filters.provider || undefined,
      statusCode: filters.statusCode || undefined,
      operation: filters.operation || undefined,
      skipReason: filters.skipReason || undefined,
      isSse: filters.isSse || undefined,
      model: filters.model || undefined,
    }),
    [filters, timeWindow],
  );

  const dashboardQuery = useQuery<DashboardData>({
    queryKey: ['admin-analytics-dashboard', timeRange, queryFilters],
    queryFn: () => getDashboard(queryFilters),
    enabled: isAdmin,
    retry: false,
  });

  const explorerQuery = useQuery<ExplorerResponse>({
    queryKey: ['admin-analytics-explorer', timeRange, queryFilters, explorerOffset],
    queryFn: () => getExplorerRows({ ...queryFilters, limit: 100, offset: explorerOffset }),
    enabled: isAdmin,
    retry: false,
  });

  useEffect(() => {
    setExplorerOffset(0);
  }, [timeRange, filters]);

  useEffect(() => {
    if (!dashboardQuery.data?.dataset || runnerSql.trim()) return;
    setRunnerSql(buildDefaultQuery(dashboardQuery.data.dataset));
  }, [dashboardQuery.data?.dataset, runnerSql]);

  const visibleExplorerColumns = useMemo(
    () => explorerColumns.filter((column) => visibility[column]),
    [visibility],
  );

  const explorerRows = useMemo(() => {
    const rows = explorerQuery.data?.rows ?? [];
    const normalizedSearch = explorerSearch.trim().toLowerCase();
    if (!normalizedSearch) return rows;
    return rows.filter((row) =>
      Object.values(row).some((value) => String(value).toLowerCase().includes(normalizedSearch)),
    );
  }, [explorerQuery.data?.rows, explorerSearch]);

  const activeBreakdownRows = dashboardQuery.data?.breakdowns[breakdownDimension] ?? [];

  async function handleRunQuery() {
    setRunnerPending(true);
    setRunnerError('');
    try {
      const result = await runAdvancedQuery({
        sql: runnerSql,
        startTimeMs: timeWindow.startTimeMs,
        endTimeMs: timeWindow.endTimeMs,
        limit: 200,
      });
      setRunnerResult(result as QueryRunnerResult);
    } catch (error) {
      setRunnerResult(null);
      setRunnerError(error instanceof Error ? error.message : 'Failed to run query');
    } finally {
      setRunnerPending(false);
    }
  }

  async function handleExportExplorer() {
    setExportPending(true);
    setExportError('');
    try {
      const result = await exportExplorerCsv({ ...queryFilters, limit: 2000 });
      downloadText(result.filename, result.csv, 'text/csv;charset=utf-8');
    } catch (error) {
      setExportError(error instanceof Error ? error.message : 'Failed to export CSV');
    } finally {
      setExportPending(false);
    }
  }

  function handleExportRunnerResult() {
    if (!runnerResult) return;
    const header = runnerResult.columns.map((column) => column.name).join(',');
    const body = runnerResult.rows
      .map((row) =>
        row
          .map((cell) => {
            const escaped = cell.replace(/"/g, '""');
            return /[",\n]/.test(escaped) ? `"${escaped}"` : escaped;
          })
          .join(','),
      )
      .join('\n');
    downloadText('analytics-engine-query.csv', `${header}\n${body}`, 'text/csv;charset=utf-8');
  }

  if (!isAdmin) {
    return (
      <div className="flex min-h-[400px] items-center justify-center">
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-8 text-center">
          <h2 className="mb-2 text-xl font-semibold text-destructive">Access Denied</h2>
          <p className="text-destructive/80">You need admin access to view this page.</p>
        </div>
      </div>
    );
  }

  const dashboardError = dashboardQuery.error ? dashboardQuery.error.message : '';
  const explorerError = explorerQuery.error ? explorerQuery.error.message : '';

  return (
    <div className="animate-fade-in space-y-8">
      <PageToolbar>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-sm font-medium text-foreground">Analytics Explorer</h1>
          {dashboardQuery.data?.dataset && (
            <Badge variant="outline" className="font-mono text-[11px]">
              {dashboardQuery.data.dataset}
            </Badge>
          )}
          {dashboardQuery.data?.granularity && (
            <Badge variant="outline" className="font-mono text-[11px]">
              Timeseries: {dashboardQuery.data.granularity}
            </Badge>
          )}
        </div>
      </PageToolbar>

      <AnalyticsFilterBar
        timeRange={timeRange}
        setTimeRange={setTimeRange}
        filters={filters}
        setFilters={setFilters}
        filterOptions={dashboardQuery.data?.filterOptions}
      />

      {dashboardQuery.isLoading ? (
        <LoadingState label="Loading Analytics Engine overview..." />
      ) : dashboardError ? (
        <SectionError message={dashboardError} />
      ) : dashboardQuery.data ? (
        <DashboardSummary
          data={dashboardQuery.data}
          chartMetric={chartMetric}
          setChartMetric={setChartMetric}
        />
      ) : null}

      <Tabs defaultValue="breakdowns">
        <TabsList variant="line">
          <TabsTrigger value="breakdowns" className="text-xs uppercase tracking-wider">
            Breakdowns
          </TabsTrigger>
          <TabsTrigger value="explorer" className="text-xs uppercase tracking-wider">
            Explorer
          </TabsTrigger>
          <TabsTrigger value="sql" className="text-xs uppercase tracking-wider">
            SQL Runner
          </TabsTrigger>
        </TabsList>

        <TabsContent value="breakdowns" className="mt-4 space-y-4">
          <BreakdownsPanel
            activeDimension={breakdownDimension}
            onDimensionChange={setBreakdownDimension}
            isLoading={dashboardQuery.isLoading}
            error={dashboardError}
            rows={activeBreakdownRows}
            search={breakdownSearch}
            setSearch={setBreakdownSearch}
          />
        </TabsContent>

        <TabsContent value="explorer" className="mt-4 space-y-4">
          <ExplorerPanel
            isLoading={explorerQuery.isLoading}
            error={explorerError}
            data={explorerQuery.data}
            rows={explorerRows}
            visibleColumns={visibleExplorerColumns}
            visibility={visibility}
            setVisibility={setVisibility}
            search={explorerSearch}
            setSearch={setExplorerSearch}
            offset={explorerOffset}
            setOffset={setExplorerOffset}
            onSelectRow={setSelectedRow}
            exportPending={exportPending}
            exportError={exportError}
            onExport={() => void handleExportExplorer()}
          />
        </TabsContent>

        <TabsContent value="sql" className="mt-4 space-y-4">
          <SqlRunnerPanel
            dataset={dashboardQuery.data?.dataset}
            sql={runnerSql}
            setSql={setRunnerSql}
            result={runnerResult}
            error={runnerError}
            pending={runnerPending}
            onRun={() => void handleRunQuery()}
            onExportResult={handleExportRunnerResult}
          />
        </TabsContent>
      </Tabs>

      <ExplorerRowDialog row={selectedRow} onClose={() => setSelectedRow(null)} />
    </div>
  );
}
