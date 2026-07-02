'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAction } from 'convex/react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@trace-flow/convex/_generated/api';
import {
  Activity,
  AlertTriangle,
  ArrowDownToLine,
  ChevronLeft,
  ChevronRight,
  Database,
  Gauge,
  Loader2,
  Search,
  TerminalSquare,
} from 'lucide-react';
import { Line, LineChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { useIsAdmin } from '@/components/admin/AdminContext';
import { PageToolbar } from '@/components/shared/PageToolbar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { FilterDropdown } from '@/components/usage/FilterDropdown';
import { useColumnVisibility } from '@/hooks/useColumnVisibility';
import { cn } from '@/lib/utils';

type TimeRangeValue = '24h' | '7d' | '30d' | '90d';
type ChartMetric = 'requestCount' | 'p95LatencyMs' | 'serverErrorRate' | 'totalTokens';
type BreakdownDimension =
  | 'provider'
  | 'statusCode'
  | 'operation'
  | 'model'
  | 'skipReason'
  | 'orgId';

interface SummaryData {
  requestCount: number;
  serverErrorCount: number;
  serverErrorRate: number;
  skipCount: number;
  skipRate: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  avgTtfbMs: number;
  p95TtfbMs: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  responseBytes: number;
}

interface TimeseriesRow {
  bucket: string;
  requestCount: number;
  serverErrorRate: number;
  skipRate: number;
  p95LatencyMs: number;
  p95TtfbMs: number;
  totalTokens: number;
  responseBytes: number;
}

interface BreakdownRow {
  dimension: string;
  requestCount: number;
  serverErrorRate: number;
  skipRate: number;
  p95LatencyMs: number;
  totalTokens: number;
  responseBytes: number;
}

interface DashboardData {
  dataset: string;
  granularity: string;
  summary: SummaryData;
  timeseries: TimeseriesRow[];
  breakdowns: Record<BreakdownDimension, BreakdownRow[]>;
  filterOptions: {
    providers: string[];
    statusCodes: string[];
    operations: string[];
    skipReasons: string[];
    models: string[];
    orgIds: string[];
  };
}

interface ExplorerRow {
  timestamp: string;
  sampleInterval: number;
  orgId: string;
  provider: string;
  statusCode: string;
  operation: string;
  skipReason: string;
  isSse: string;
  model: string;
  totalLatencyMs: number;
  prepLatencyMs: number;
  ttfbMs: number;
  isServerError: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  responseBytes: number;
}

interface ExplorerResponse {
  sql: string;
  columns: { name: string; type: string }[];
  rows: ExplorerRow[];
  limit: number;
  offset: number;
  hasMore: boolean;
}

interface QueryRunnerResult {
  sql: string;
  columns: { name: string; type: string }[];
  rows: string[][];
  rowCount: number;
}

interface FiltersState {
  orgId: string;
  provider: string;
  statusCode: string;
  operation: string;
  skipReason: string;
  isSse: '' | '0' | '1';
  model: string;
}

const TIME_RANGES: { value: TimeRangeValue; label: string; ms: number }[] = [
  { value: '24h', label: '24h', ms: 24 * 60 * 60 * 1000 },
  { value: '7d', label: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
  { value: '30d', label: '30d', ms: 30 * 24 * 60 * 60 * 1000 },
  { value: '90d', label: '90d', ms: 90 * 24 * 60 * 60 * 1000 },
];

const EMPTY_VALUE = '__empty__';

// Consistent color-to-metric mapping using chart CSS variables
const ACCENT = {
  requests: 'var(--chart-1)',
  errors: 'var(--chart-6)',
  latency: 'var(--chart-4)',
  tokens: 'var(--chart-3)',
  skipRate: 'var(--chart-2)',
  ttfb: 'var(--chart-7)',
  promptComp: 'var(--chart-5)',
  bytes: 'var(--chart-8)',
} as const;

const explorerDefaultVisibility = {
  timestamp: true,
  sampleInterval: true,
  orgId: true,
  provider: true,
  statusCode: true,
  operation: true,
  skipReason: true,
  isSse: true,
  model: true,
  totalLatencyMs: true,
  prepLatencyMs: false,
  ttfbMs: true,
  isServerError: true,
  totalTokens: true,
  promptTokens: false,
  completionTokens: false,
  cacheReadTokens: false,
  responseBytes: true,
};

const chartConfig = {
  requestCount: { label: 'Requests', color: 'var(--chart-1)' },
  p95LatencyMs: { label: 'P95 Latency', color: 'var(--chart-4)' },
  serverErrorRate: { label: 'Error Rate', color: 'var(--chart-6)' },
  totalTokens: { label: 'Tokens', color: 'var(--chart-3)' },
};

const CHART_METRIC_COLORS: Record<ChartMetric, string> = {
  requestCount: ACCENT.requests,
  p95LatencyMs: ACCENT.latency,
  serverErrorRate: ACCENT.errors,
  totalTokens: ACCENT.tokens,
};

const explorerColumns = [
  'timestamp',
  'sampleInterval',
  'orgId',
  'provider',
  'statusCode',
  'operation',
  'skipReason',
  'isSse',
  'model',
  'totalLatencyMs',
  'prepLatencyMs',
  'ttfbMs',
  'isServerError',
  'totalTokens',
  'promptTokens',
  'completionTokens',
  'cacheReadTokens',
  'responseBytes',
] as const;

const NUMERIC_EXPLORER_COLUMNS = new Set([
  'sampleInterval',
  'totalLatencyMs',
  'prepLatencyMs',
  'ttfbMs',
  'isServerError',
  'totalTokens',
  'promptTokens',
  'completionTokens',
  'cacheReadTokens',
  'responseBytes',
]);

const STATUS_FIELDS = new Set(['statusCode', 'isServerError', 'isSse']);

function formatCompactNumber(value: number) {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(
    value,
  );
}

function formatInteger(value: number) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);
}

function formatPercentage(value: number) {
  return `${(value * 100).toFixed(value > 0.1 ? 1 : 2)}%`;
}

function formatBytes(value: number) {
  if (value === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const scaled = value / 1024 ** index;
  return `${scaled.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatDuration(value: number) {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(2)} s`;
  }
  return `${value.toFixed(0)} ms`;
}

function formatCellValue(value: string) {
  if (!value) return '(empty)';
  if (value === EMPTY_VALUE) return '(empty)';
  return value;
}

const BOOLEAN_COLUMNS = new Set(['isServerError', 'isSse']);

function formatBooleanCell(value: string) {
  if (value === '1') return 'Yes';
  if (value === '0') return 'No';
  return value;
}

function downloadText(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function quoteDataset(dataset: string) {
  return `"${dataset.replace(/"/g, '""')}"`;
}

function buildDefaultQuery(dataset: string) {
  const tableName = quoteDataset(dataset);
  return `SELECT
  formatDateTime(timestamp, '%Y-%m-%d %H:%M:%S') AS bucket,
  index1 AS org_id,
  blob1 AS provider,
  blob2 AS status_code,
  blob3 AS operation,
  double1 AS total_latency_ms,
  double5 AS total_tokens
FROM ${tableName}
WHERE __TIME_FILTER__
ORDER BY timestamp DESC
LIMIT 100`;
}

function buildPresetQuery(dataset: string, preset: 'slow' | 'skips' | 'orgs') {
  const tableName = quoteDataset(dataset);
  if (preset === 'slow') {
    return `SELECT
  formatDateTime(timestamp, '%Y-%m-%d %H:%M:%S') AS ts,
  index1 AS org_id,
  blob1 AS provider,
  blob6 AS model,
  double1 AS total_latency_ms,
  double3 AS ttfb_ms,
  double5 AS total_tokens
FROM ${tableName}
WHERE __TIME_FILTER__ AND double1 > 2000
ORDER BY total_latency_ms DESC
LIMIT 100`;
  }

  if (preset === 'skips') {
    return `SELECT
  if(blob4 = '', '(none)', blob4) AS skip_reason,
  SUM(_sample_interval) AS request_count,
  SUM(_sample_interval * double5) AS total_tokens
FROM ${tableName}
WHERE __TIME_FILTER__
GROUP BY skip_reason
ORDER BY request_count DESC
LIMIT 50`;
  }

  return `SELECT
  index1 AS org_id,
  SUM(_sample_interval) AS request_count,
  sumIf(_sample_interval, double4 > 0) AS server_error_count,
  quantileExactWeighted(0.95)(double1, _sample_interval) AS p95_latency_ms,
  SUM(_sample_interval * double5) AS total_tokens
FROM ${tableName}
WHERE __TIME_FILTER__
GROUP BY org_id
ORDER BY request_count DESC
LIMIT 50`;
}

function SummaryCard({
  title,
  value,
  description,
  icon,
  accentColor,
}: {
  title: string;
  value: string;
  description: string;
  icon: React.ReactNode;
  accentColor: string;
}) {
  return (
    <div
      className="rounded-lg border border-border/60 border-l-2 p-4"
      style={{ borderLeftColor: accentColor }}
    >
      <div className="flex items-start justify-between">
        <p className="text-[11px] uppercase tracking-widest text-muted-foreground">{title}</p>
        <div style={{ color: accentColor }}>{icon}</div>
      </div>
      <p className="tabular-mono mt-2 text-3xl font-semibold">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{description}</p>
    </div>
  );
}

function SectionError({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
      {message}
    </div>
  );
}

function LoadingState({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
      {label}
    </div>
  );
}

function OverviewChart({
  rows,
  metric,
  onMetricChange,
}: {
  rows: TimeseriesRow[];
  metric: ChartMetric;
  onMetricChange: (value: ChartMetric) => void;
}) {
  const formatter =
    metric === 'requestCount'
      ? formatInteger
      : metric === 'p95LatencyMs'
        ? formatDuration
        : metric === 'serverErrorRate'
          ? formatPercentage
          : formatCompactNumber;

  return (
    <Card className="bg-card/40">
      <CardHeader className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle>Time Series</CardTitle>
            <CardDescription>
              Weighted aggregates from the proxy Analytics Engine dataset.
            </CardDescription>
          </div>
          <div className="flex gap-1 rounded-lg border border-border bg-background p-1">
            {(
              ['requestCount', 'p95LatencyMs', 'serverErrorRate', 'totalTokens'] as ChartMetric[]
            ).map((value) => (
              <button
                key={value}
                onClick={() => onMetricChange(value)}
                className={cn(
                  'relative rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                  metric === value
                    ? 'text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
                style={
                  metric === value
                    ? { borderBottom: `2px solid ${CHART_METRIC_COLORS[value]}` }
                    : undefined
                }
              >
                {chartConfig[value].label}
              </button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <ChartContainer config={chartConfig} className="h-[320px] w-full">
          <LineChart data={rows}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" opacity={0.3} />
            <XAxis
              dataKey="bucket"
              tickLine={false}
              axisLine={false}
              minTickGap={24}
              tickFormatter={(value) => String(value).slice(5)}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              width={80}
              tickFormatter={(value) => formatter(Number(value))}
            />
            <ChartTooltip
              content={<ChartTooltipContent valueFormatter={(value) => formatter(Number(value))} />}
            />
            <Line
              type="monotone"
              dataKey={metric}
              stroke={`var(--color-${metric})`}
              strokeWidth={2}
              dot={false}
            />
          </LineChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

function BreakdownTable({
  rows,
  search,
  onSearchChange,
}: {
  rows: BreakdownRow[];
  search: string;
  onSearchChange: (value: string) => void;
}) {
  const [sortKey, setSortKey] = useState<keyof BreakdownRow>('requestCount');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');

  const filteredRows = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    const nextRows = normalizedSearch
      ? rows.filter((row) =>
          formatCellValue(row.dimension).toLowerCase().includes(normalizedSearch),
        )
      : rows;

    return [...nextRows].sort((a, b) => {
      const left = a[sortKey];
      const right = b[sortKey];
      const direction = sortDirection === 'asc' ? 1 : -1;
      if (typeof left === 'string' && typeof right === 'string') {
        return left.localeCompare(right) * direction;
      }
      return (Number(left) - Number(right)) * direction;
    });
  }, [rows, search, sortKey, sortDirection]);

  const handleSort = (key: keyof BreakdownRow) => {
    if (sortKey === key) {
      setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setSortKey(key);
    setSortDirection(key === 'dimension' ? 'asc' : 'desc');
  };

  const sortIndicator = (key: keyof BreakdownRow) => {
    if (sortKey !== key) return null;
    return (
      <span className="ml-1 text-primary">{sortDirection === 'asc' ? '\u2191' : '\u2193'}</span>
    );
  };

  return (
    <Card className="bg-card/40">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle>Breakdown Table</CardTitle>
            <CardDescription>Search and sort any grouped dimension.</CardDescription>
          </div>
          <div className="relative w-full max-w-xs">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="Search current dimension"
              className="pl-9"
            />
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>
                <button
                  onClick={() => handleSort('dimension')}
                  className="text-[11px] uppercase tracking-wider font-medium text-muted-foreground hover:text-foreground"
                >
                  Dimension{sortIndicator('dimension')}
                </button>
              </TableHead>
              <TableHead>
                <button
                  onClick={() => handleSort('requestCount')}
                  className="text-[11px] uppercase tracking-wider font-medium text-muted-foreground hover:text-foreground"
                >
                  Requests{sortIndicator('requestCount')}
                </button>
              </TableHead>
              <TableHead>
                <button
                  onClick={() => handleSort('serverErrorRate')}
                  className="text-[11px] uppercase tracking-wider font-medium text-muted-foreground hover:text-foreground"
                >
                  Server Errors{sortIndicator('serverErrorRate')}
                </button>
              </TableHead>
              <TableHead>
                <button
                  onClick={() => handleSort('skipRate')}
                  className="text-[11px] uppercase tracking-wider font-medium text-muted-foreground hover:text-foreground"
                >
                  Skip Rate{sortIndicator('skipRate')}
                </button>
              </TableHead>
              <TableHead>
                <button
                  onClick={() => handleSort('p95LatencyMs')}
                  className="text-[11px] uppercase tracking-wider font-medium text-muted-foreground hover:text-foreground"
                >
                  P95 Latency{sortIndicator('p95LatencyMs')}
                </button>
              </TableHead>
              <TableHead>
                <button
                  onClick={() => handleSort('totalTokens')}
                  className="text-[11px] uppercase tracking-wider font-medium text-muted-foreground hover:text-foreground"
                >
                  Tokens{sortIndicator('totalTokens')}
                </button>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredRows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                  No rows match the current search.
                </TableCell>
              </TableRow>
            ) : (
              filteredRows.map((row) => (
                <TableRow key={row.dimension} className="even:bg-muted/20">
                  <TableCell className="font-medium">
                    {row.dimension && row.dimension !== EMPTY_VALUE ? (
                      formatCellValue(row.dimension)
                    ) : (
                      <span className="italic text-muted-foreground/60">(empty)</span>
                    )}
                  </TableCell>
                  <TableCell className="tabular-mono">{formatInteger(row.requestCount)}</TableCell>
                  <TableCell className="tabular-mono">
                    {formatPercentage(row.serverErrorRate)}
                  </TableCell>
                  <TableCell className="tabular-mono">{formatPercentage(row.skipRate)}</TableCell>
                  <TableCell className="tabular-mono">{formatDuration(row.p95LatencyMs)}</TableCell>
                  <TableCell className="tabular-mono">
                    {formatCompactNumber(row.totalTokens)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function QueryResultTable({ result }: { result: QueryRunnerResult | null }) {
  if (!result) return null;

  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <div className="border-b border-border bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
        {result.rowCount} row{result.rowCount === 1 ? '' : 's'}
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            {result.columns.map((column) => (
              <TableHead key={column.name}>{column.name}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {result.rows.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={result.columns.length}
                className="py-8 text-center text-muted-foreground"
              >
                Query returned no rows.
              </TableCell>
            </TableRow>
          ) : (
            result.rows.map((row, index) => (
              <TableRow key={`${index}-${row.join('|')}`}>
                {row.map((cell, cellIndex) => (
                  <TableCell key={`${index}-${cellIndex}`} className="tabular-mono">
                    {cell || ' '}
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}

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

  const hasActiveFilters = Object.values(filters).some(Boolean);

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

      {/* Filters — compact inline bar */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border/60 bg-card/30 px-4 py-2.5">
        {TIME_RANGES.map((range) => (
          <button
            key={range.value}
            onClick={() => setTimeRange(range.value)}
            className={cn(
              'rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
              timeRange === range.value
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border bg-background text-muted-foreground hover:text-foreground',
            )}
          >
            {range.label}
          </button>
        ))}
        <div className="h-5 w-px bg-border/60" />
        <Input
          value={filters.orgId}
          onChange={(event) => setFilters((current) => ({ ...current, orgId: event.target.value }))}
          placeholder="Org ID"
          className="h-8 w-32 text-xs"
        />
        <FilterDropdown
          label="Provider"
          value={filters.provider}
          options={dashboardQuery.data?.filterOptions.providers ?? []}
          onChange={(value) => setFilters((current) => ({ ...current, provider: value }))}
        />
        <FilterDropdown
          label="Status"
          value={filters.statusCode}
          options={dashboardQuery.data?.filterOptions.statusCodes ?? []}
          onChange={(value) => setFilters((current) => ({ ...current, statusCode: value }))}
        />
        <FilterDropdown
          label="Operation"
          value={filters.operation}
          options={dashboardQuery.data?.filterOptions.operations ?? []}
          onChange={(value) => setFilters((current) => ({ ...current, operation: value }))}
        />
        <FilterDropdown
          label="Model"
          value={filters.model}
          options={dashboardQuery.data?.filterOptions.models ?? []}
          onChange={(value) => setFilters((current) => ({ ...current, model: value }))}
        />
        <FilterDropdown
          label="Skip"
          value={filters.skipReason}
          options={dashboardQuery.data?.filterOptions.skipReasons ?? []}
          onChange={(value) => setFilters((current) => ({ ...current, skipReason: value }))}
        />
        <FilterDropdown
          label="SSE"
          value={filters.isSse}
          options={['1', '0']}
          onChange={(value) =>
            setFilters((current) => ({ ...current, isSse: value as '' | '0' | '1' }))
          }
        />
        {hasActiveFilters && (
          <Button
            variant="ghost"
            size="sm"
            className="text-xs"
            onClick={() =>
              setFilters({
                orgId: '',
                provider: '',
                statusCode: '',
                operation: '',
                skipReason: '',
                isSse: '',
                model: '',
              })
            }
          >
            Clear Filters
          </Button>
        )}
      </div>

      {dashboardQuery.isLoading ? (
        <LoadingState label="Loading Analytics Engine overview..." />
      ) : dashboardError ? (
        <SectionError message={dashboardError} />
      ) : dashboardQuery.data ? (
        <>
          <div className="stagger-children grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <SummaryCard
              title="Requests"
              value={formatCompactNumber(dashboardQuery.data.summary.requestCount)}
              description="Weighted event count using sum(_sample_interval)."
              icon={<Activity className="h-4 w-4" />}
              accentColor={ACCENT.requests}
            />
            <SummaryCard
              title="Server Errors"
              value={formatPercentage(dashboardQuery.data.summary.serverErrorRate)}
              description={`${formatInteger(dashboardQuery.data.summary.serverErrorCount)} weighted server errors.`}
              icon={<AlertTriangle className="h-4 w-4" />}
              accentColor={ACCENT.errors}
            />
            <SummaryCard
              title="P95 Latency"
              value={formatDuration(dashboardQuery.data.summary.p95LatencyMs)}
              description={`P50 ${formatDuration(dashboardQuery.data.summary.p50LatencyMs)} \u2022 P99 ${formatDuration(dashboardQuery.data.summary.p99LatencyMs)}`}
              icon={<Gauge className="h-4 w-4" />}
              accentColor={ACCENT.latency}
            />
            <SummaryCard
              title="Token Volume"
              value={formatCompactNumber(dashboardQuery.data.summary.totalTokens)}
              description={`${formatBytes(dashboardQuery.data.summary.responseBytes)} of response payloads.`}
              icon={<Database className="h-4 w-4" />}
              accentColor={ACCENT.tokens}
            />
          </div>

          <OverviewChart
            rows={dashboardQuery.data.timeseries}
            metric={chartMetric}
            onMetricChange={setChartMetric}
          />

          {/* Operational Totals */}
          <div className="stagger-children grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <div
              className="rounded-lg border border-border/60 border-l-2 p-4"
              style={{ borderLeftColor: ACCENT.skipRate }}
            >
              <p className="text-[11px] uppercase tracking-widest text-muted-foreground">
                Skip Rate
              </p>
              <p className="tabular-mono mt-2 text-xl font-semibold">
                {formatPercentage(dashboardQuery.data.summary.skipRate)}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {formatInteger(dashboardQuery.data.summary.skipCount)} weighted skipped requests
              </p>
            </div>
            <div
              className="rounded-lg border border-border/60 border-l-2 p-4"
              style={{ borderLeftColor: ACCENT.ttfb }}
            >
              <p className="text-[11px] uppercase tracking-widest text-muted-foreground">
                Avg TTFB
              </p>
              <p className="tabular-mono mt-2 text-xl font-semibold">
                {formatDuration(dashboardQuery.data.summary.avgTtfbMs)}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                P95 {formatDuration(dashboardQuery.data.summary.p95TtfbMs)}
              </p>
            </div>
            <div
              className="rounded-lg border border-border/60 border-l-2 p-4"
              style={{ borderLeftColor: ACCENT.promptComp }}
            >
              <p className="text-[11px] uppercase tracking-widest text-muted-foreground">
                Prompt vs Completion
              </p>
              <p className="tabular-mono mt-2 text-xl font-semibold">
                {formatCompactNumber(dashboardQuery.data.summary.promptTokens)} /{' '}
                {formatCompactNumber(dashboardQuery.data.summary.completionTokens)}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Cache reads {formatCompactNumber(dashboardQuery.data.summary.cacheReadTokens)}
              </p>
            </div>
            <div
              className="rounded-lg border border-border/60 border-l-2 p-4"
              style={{ borderLeftColor: ACCENT.bytes }}
            >
              <p className="text-[11px] uppercase tracking-widest text-muted-foreground">
                Average Latency
              </p>
              <p className="tabular-mono mt-2 text-xl font-semibold">
                {formatDuration(dashboardQuery.data.summary.avgLatencyMs)}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Total bytes {formatBytes(dashboardQuery.data.summary.responseBytes)}
              </p>
            </div>
          </div>
        </>
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
          <Card className="bg-card/40">
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <CardTitle>Dimension Analysis</CardTitle>
                  <CardDescription>
                    Compare request volume, latency, and errors by dimension.
                  </CardDescription>
                </div>
                <div className="flex flex-wrap gap-2">
                  {(
                    [
                      'provider',
                      'statusCode',
                      'operation',
                      'model',
                      'skipReason',
                      'orgId',
                    ] as BreakdownDimension[]
                  ).map((dimension) => (
                    <button
                      key={dimension}
                      onClick={() => setBreakdownDimension(dimension)}
                      className={cn(
                        'rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
                        breakdownDimension === dimension
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border bg-background text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {dimension}
                    </button>
                  ))}
                </div>
              </div>
            </CardHeader>
          </Card>
          {dashboardQuery.isLoading ? (
            <LoadingState label="Loading grouped breakdowns..." />
          ) : dashboardError ? (
            <SectionError message={dashboardError} />
          ) : (
            <BreakdownTable
              rows={activeBreakdownRows}
              search={breakdownSearch}
              onSearchChange={setBreakdownSearch}
            />
          )}
        </TabsContent>

        <TabsContent value="explorer" className="mt-4 space-y-4">
          <Card className="bg-card/40">
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <CardTitle>Raw Event Explorer</CardTitle>
                  <CardDescription>
                    Page through sampled Analytics Engine rows, inspect fields, and export filtered
                    results.
                  </CardDescription>
                </div>
                <Button
                  variant="outline"
                  onClick={() => void handleExportExplorer()}
                  disabled={exportPending}
                >
                  {exportPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <ArrowDownToLine className="h-4 w-4" />
                  )}
                  Export CSV
                </Button>
              </div>
              {exportError && <SectionError message={exportError} />}
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-3">
                <div className="relative max-w-sm">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={explorerSearch}
                    onChange={(event) => setExplorerSearch(event.target.value)}
                    placeholder="Search the current explorer page"
                    className="pl-9"
                  />
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {explorerColumns.map((column) => (
                    <button
                      key={column}
                      onClick={() =>
                        setVisibility((current) => ({
                          ...current,
                          [column]: !current[column],
                        }))
                      }
                      className={cn(
                        'rounded-full border px-2 py-0.5 text-[11px] transition-colors',
                        visibility[column]
                          ? 'border-primary/30 bg-primary/10 text-primary'
                          : 'border-transparent bg-muted/40 text-muted-foreground hover:border-border',
                      )}
                    >
                      {column}
                    </button>
                  ))}
                </div>
              </div>

              {explorerQuery.isLoading ? (
                <LoadingState label="Loading explorer rows..." />
              ) : explorerError ? (
                <SectionError message={explorerError} />
              ) : (
                <>
                  <div className="overflow-hidden rounded-xl border border-border">
                    <div className="border-b border-border bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
                      Current SQL
                    </div>
                    <pre className="tabular-mono overflow-x-auto bg-background/60 p-4 text-[11px] text-muted-foreground">
                      {explorerQuery.data?.sql}
                    </pre>
                  </div>
                  <div className="overflow-hidden rounded-xl border border-border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          {visibleExplorerColumns.map((column) => (
                            <TableHead key={column}>{column}</TableHead>
                          ))}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {explorerRows.length === 0 ? (
                          <TableRow>
                            <TableCell
                              colSpan={visibleExplorerColumns.length}
                              className="py-8 text-center text-muted-foreground"
                            >
                              No explorer rows match the current page or search.
                            </TableCell>
                          </TableRow>
                        ) : (
                          explorerRows.map((row, index) => (
                            <TableRow
                              key={`${index}-${row.timestamp}-${row.orgId}-${row.model}-${row.totalLatencyMs}`}
                              className="table-row-interactive cursor-pointer"
                              onClick={() => setSelectedRow(row)}
                            >
                              {visibleExplorerColumns.map((column) => (
                                <TableCell
                                  key={column}
                                  className={
                                    NUMERIC_EXPLORER_COLUMNS.has(column) ? 'tabular-mono' : ''
                                  }
                                >
                                  {typeof row[column] === 'number'
                                    ? formatInteger(Number(row[column]))
                                    : BOOLEAN_COLUMNS.has(column)
                                      ? formatBooleanCell(String(row[column]))
                                      : formatCellValue(String(row[column]))}
                                </TableCell>
                              ))}
                            </TableRow>
                          ))
                        )}
                      </TableBody>
                    </Table>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <p className="tabular-mono text-[11px] text-muted-foreground">
                      Offset {explorerQuery.data?.offset ?? 0} &bull; Page size{' '}
                      {explorerQuery.data?.limit ?? 100}
                    </p>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        disabled={explorerOffset === 0}
                        onClick={() => setExplorerOffset((current) => Math.max(0, current - 100))}
                      >
                        <ChevronLeft className="h-4 w-4" />
                        Previous
                      </Button>
                      <Button
                        variant="outline"
                        disabled={!explorerQuery.data?.hasMore}
                        onClick={() => setExplorerOffset((current) => current + 100)}
                      >
                        Next
                        <ChevronRight className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="sql" className="mt-4 space-y-4">
          <Card className="bg-card/40">
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <CardTitle>Guarded SQL Runner</CardTitle>
                  <CardDescription>
                    Read-only `SELECT` against the configured dataset. Queries must include
                    `__TIME_FILTER__`.
                  </CardDescription>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    className="text-xs"
                    onClick={() =>
                      dashboardQuery.data?.dataset &&
                      setRunnerSql(buildPresetQuery(dashboardQuery.data.dataset, 'slow'))
                    }
                  >
                    Slow Requests
                  </Button>
                  <Button
                    variant="outline"
                    className="text-xs"
                    onClick={() =>
                      dashboardQuery.data?.dataset &&
                      setRunnerSql(buildPresetQuery(dashboardQuery.data.dataset, 'skips'))
                    }
                  >
                    Skip Reasons
                  </Button>
                  <Button
                    variant="outline"
                    className="text-xs"
                    onClick={() =>
                      dashboardQuery.data?.dataset &&
                      setRunnerSql(buildPresetQuery(dashboardQuery.data.dataset, 'orgs'))
                    }
                  >
                    Top Orgs
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <textarea
                id="sql-runner"
                value={runnerSql}
                onChange={(event) => setRunnerSql(event.target.value)}
                className="tabular-mono min-h-[220px] w-full rounded-xl border border-border bg-background/60 p-4 text-[13px] outline-none ring-0"
                spellCheck={false}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  onClick={() => void handleRunQuery()}
                  disabled={runnerPending || !runnerSql.trim()}
                >
                  {runnerPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <TerminalSquare className="h-4 w-4" />
                  )}
                  Run Query
                </Button>
                <Button
                  variant="outline"
                  onClick={handleExportRunnerResult}
                  disabled={!runnerResult}
                >
                  <ArrowDownToLine className="h-4 w-4" />
                  Export Results
                </Button>
              </div>
              {runnerError && <SectionError message={runnerError} />}
              {runnerResult && (
                <>
                  <div className="overflow-hidden rounded-xl border border-border">
                    <div className="border-b border-border bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
                      Final SQL
                    </div>
                    <pre className="tabular-mono overflow-x-auto bg-background/60 p-4 text-[11px] text-muted-foreground">
                      {runnerResult.sql}
                    </pre>
                  </div>
                  <QueryResultTable result={runnerResult} />
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Dialog open={!!selectedRow} onOpenChange={(open) => !open && setSelectedRow(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Explorer Row</DialogTitle>
            <DialogDescription>
              Inspect the raw Analytics Engine fields for the selected row.
            </DialogDescription>
          </DialogHeader>
          {selectedRow && (
            <div className="grid gap-3 sm:grid-cols-2">
              {Object.entries(selectedRow).map(([key, value]) => {
                const formatted =
                  typeof value === 'number'
                    ? formatInteger(value)
                    : BOOLEAN_COLUMNS.has(key)
                      ? formatBooleanCell(String(value))
                      : formatCellValue(String(value));
                return (
                  <div
                    key={key}
                    className="rounded-lg border border-border/60 border-l-2 border-l-border bg-background/40 p-3"
                  >
                    <p className="text-[11px] uppercase tracking-widest text-muted-foreground">
                      {key}
                    </p>
                    {STATUS_FIELDS.has(key) ? (
                      <Badge variant="outline" className="tabular-mono mt-1 text-sm">
                        {formatted}
                      </Badge>
                    ) : (
                      <p className="tabular-mono mt-1 break-all text-sm">{formatted}</p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
