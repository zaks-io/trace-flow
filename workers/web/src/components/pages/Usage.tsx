'use client';

import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import {
  Activity,
  DollarSign,
  ChevronDown,
  ChevronUp,
  ArrowUpDown,
  Layers,
  Server,
  Cpu,
  TrendingDown,
  Timer,
} from 'lucide-react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  PieChart,
  Pie,
  BarChart,
  Bar,
  CartesianGrid,
} from 'recharts';
import { useTinybirdPipe } from '@/hooks/useTinybirdPipe';
import { usePageHeader } from '@/components/PageHeaderContext';
import { formatNumber, formatCurrency, formatPercent, formatDuration } from '@/lib/format';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';

type TimeRange = '7d' | '30d' | '90d';

const TIME_RANGES: { value: TimeRange; label: string; ms: number }[] = [
  { value: '7d', label: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
  { value: '30d', label: '30d', ms: 30 * 24 * 60 * 60 * 1000 },
  { value: '90d', label: '90d', ms: 90 * 24 * 60 * 60 * 1000 },
];

type TimeseriesMetric = 'cost' | 'tokens' | 'requests' | 'latency';

const costChartConfig = {
  input_cost_usd: { label: 'Input', color: '#8b5cf6' },
  output_cost_usd: { label: 'Output', color: '#3b82f6' },
  cache_read_cost_usd: { label: 'Cache Read', color: '#10b981' },
  cache_creation_cost_usd: { label: 'Cache Write', color: '#f59e0b' },
  reasoning_cost_usd: { label: 'Reasoning', color: '#ef4444' },
} satisfies ChartConfig;

const latencyChartConfig = {
  avg_duration_ms: { label: 'Avg', color: '#f59e0b' },
  p95_duration_ms: { label: 'P95', color: '#ef4444' },
} satisfies ChartConfig;

const tokensChartConfig = {
  total_tokens: { label: 'Tokens', color: '#10b981' },
} satisfies ChartConfig;

const requestsChartConfig = {
  request_count: { label: 'Requests', color: '#8b5cf6' },
} satisfies ChartConfig;

const PIE_COLORS = ['#8b5cf6', '#3b82f6', '#10b981', '#f59e0b', '#ef4444'] as const;

const pieChartConfig = {
  value: { label: 'Cost' },
  input: { label: 'Input', color: '#8b5cf6' },
  output: { label: 'Output', color: '#3b82f6' },
  cache_read: { label: 'Cache Read', color: '#10b981' },
  cache_write: { label: 'Cache Write', color: '#f59e0b' },
  reasoning: { label: 'Reasoning', color: '#ef4444' },
} satisfies ChartConfig;

const providerChartConfig = {
  total_cost_usd: { label: 'Cost', color: '#8b5cf6' },
} satisfies ChartConfig;

interface CostBreakdownRow {
  input_cost_usd: number;
  output_cost_usd: number;
  cache_read_cost_usd: number;
  cache_creation_cost_usd: number;
  reasoning_cost_usd: number;
}

interface LatencyRow {
  avg_duration_ms: number;
  max_duration_ms: number;
  p95_duration_ms: number;
}

interface SummaryRow extends CostBreakdownRow, LatencyRow {
  request_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  reasoning_tokens: number;
  total_cost_usd: number;
  total_tokens: number;
  new_input_tokens: number;
}

interface TimeseriesRow extends CostBreakdownRow, LatencyRow {
  bucket_start: string;
  request_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  reasoning_tokens: number;
  total_cost_usd: number;
  total_tokens: number;
  new_input_tokens: number;
}

interface ModelRow extends CostBreakdownRow, LatencyRow {
  model: string;
  request_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  reasoning_tokens: number;
  total_cost_usd: number;
  cost_per_1k_output_tokens: number | null;
  total_tokens: number;
}

interface ProviderRow extends CostBreakdownRow, LatencyRow {
  provider: string;
  request_count: number;
  total_cost_usd: number;
  total_tokens: number;
}

interface OperationRow extends CostBreakdownRow, LatencyRow {
  operation: string;
  request_count: number;
  total_cost_usd: number;
  total_tokens: number;
}

interface TinybirdResponse<T> {
  data: T[];
}

// --- Summary Cards ---

interface SummaryCardProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  subtitle?: string;
  accent?: 'purple' | 'blue' | 'emerald' | 'amber';
}

function SummaryCard({ icon, label, value, subtitle, accent = 'purple' }: SummaryCardProps) {
  const accentColors = {
    purple: 'from-purple-500/20 to-purple-500/5 border-purple-500/30',
    blue: 'from-blue-500/20 to-blue-500/5 border-blue-500/30',
    emerald: 'from-emerald-500/20 to-emerald-500/5 border-emerald-500/30',
    amber: 'from-amber-500/20 to-amber-500/5 border-amber-500/30',
  };
  const iconColors = {
    purple: 'text-purple-400',
    blue: 'text-blue-400',
    emerald: 'text-emerald-400',
    amber: 'text-amber-400',
  };

  return (
    <div
      className={`relative overflow-hidden rounded-xl border bg-linear-to-br p-4 ${accentColors[accent]}`}
    >
      <div className="flex items-start justify-between">
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {label}
          </p>
          <p className="mt-1 font-mono text-2xl font-semibold tabular-nums text-foreground">
            {value}
          </p>
          {subtitle && <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>}
        </div>
        <div className={`rounded-lg bg-background/50 p-2 ${iconColors[accent]}`}>{icon}</div>
      </div>
    </div>
  );
}

// --- Cost Timeseries Chart ---

function formatTickDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function CostTimeseriesChart({
  data,
  metric,
}: {
  data: TimeseriesRow[];
  metric: TimeseriesMetric;
}) {
  if (!data || data.length === 0) {
    return <p className="text-sm text-muted-foreground">No usage data available</p>;
  }

  if (metric === 'cost') {
    return (
      <ChartContainer config={costChartConfig} className="!aspect-auto h-[300px] w-full">
        <AreaChart data={data}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="bucket_start" tickFormatter={formatTickDate} tick={{ fontSize: 11 }} />
          <YAxis
            tickFormatter={(v: number) => formatCurrency(v)}
            tick={{ fontSize: 11 }}
            width={60}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={(label) => formatTickDate(String(label))}
                formatter={(value) => formatCurrency(Number(value))}
              />
            }
          />
          <Area
            type="monotone"
            dataKey="input_cost_usd"
            stackId="1"
            fill="var(--color-input_cost_usd)"
            stroke="var(--color-input_cost_usd)"
            fillOpacity={0.6}
          />
          <Area
            type="monotone"
            dataKey="output_cost_usd"
            stackId="1"
            fill="var(--color-output_cost_usd)"
            stroke="var(--color-output_cost_usd)"
            fillOpacity={0.6}
          />
          <Area
            type="monotone"
            dataKey="cache_read_cost_usd"
            stackId="1"
            fill="var(--color-cache_read_cost_usd)"
            stroke="var(--color-cache_read_cost_usd)"
            fillOpacity={0.6}
          />
          <Area
            type="monotone"
            dataKey="cache_creation_cost_usd"
            stackId="1"
            fill="var(--color-cache_creation_cost_usd)"
            stroke="var(--color-cache_creation_cost_usd)"
            fillOpacity={0.6}
          />
          <Area
            type="monotone"
            dataKey="reasoning_cost_usd"
            stackId="1"
            fill="var(--color-reasoning_cost_usd)"
            stroke="var(--color-reasoning_cost_usd)"
            fillOpacity={0.6}
          />
        </AreaChart>
      </ChartContainer>
    );
  }

  if (metric === 'latency') {
    return (
      <ChartContainer config={latencyChartConfig} className="!aspect-auto h-[300px] w-full">
        <AreaChart data={data}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="bucket_start" tickFormatter={formatTickDate} tick={{ fontSize: 11 }} />
          <YAxis
            tickFormatter={(v: number) => formatDuration(v)}
            tick={{ fontSize: 11 }}
            width={60}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={(label) => formatTickDate(String(label))}
                formatter={(value) => formatDuration(Number(value))}
              />
            }
          />
          <Area
            type="monotone"
            dataKey="avg_duration_ms"
            fill="var(--color-avg_duration_ms)"
            stroke="var(--color-avg_duration_ms)"
            fillOpacity={0.3}
          />
          <Area
            type="monotone"
            dataKey="p95_duration_ms"
            fill="var(--color-p95_duration_ms)"
            stroke="var(--color-p95_duration_ms)"
            fillOpacity={0.15}
          />
        </AreaChart>
      </ChartContainer>
    );
  }

  const config = metric === 'tokens' ? tokensChartConfig : requestsChartConfig;
  const dataKey = metric === 'tokens' ? 'total_tokens' : 'request_count';

  return (
    <ChartContainer config={config} className="!aspect-auto h-[300px] w-full">
      <AreaChart data={data}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="bucket_start" tickFormatter={formatTickDate} tick={{ fontSize: 11 }} />
        <YAxis tickFormatter={(v: number) => formatNumber(v)} tick={{ fontSize: 11 }} width={60} />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(label) => formatTickDate(String(label))}
              formatter={(value) => formatNumber(Number(value))}
            />
          }
        />
        <Area
          type="monotone"
          dataKey={dataKey}
          fill={`var(--color-${dataKey})`}
          stroke={`var(--color-${dataKey})`}
          fillOpacity={0.3}
        />
      </AreaChart>
    </ChartContainer>
  );
}

// --- Cost Breakdown Donut ---

function CostBreakdownChart({ summary }: { summary: SummaryRow }) {
  const entries = [
    { key: 'input', label: 'Input', value: summary.input_cost_usd, color: PIE_COLORS[0] },
    { key: 'output', label: 'Output', value: summary.output_cost_usd, color: PIE_COLORS[1] },
    {
      key: 'cache_read',
      label: 'Cache Read',
      value: summary.cache_read_cost_usd,
      color: PIE_COLORS[2],
    },
    {
      key: 'cache_write',
      label: 'Cache Write',
      value: summary.cache_creation_cost_usd,
      color: PIE_COLORS[3],
    },
    {
      key: 'reasoning',
      label: 'Reasoning',
      value: summary.reasoning_cost_usd,
      color: PIE_COLORS[4],
    },
  ].filter((e) => e.value > 0);

  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground">No cost data available</p>;
  }

  const total = entries.reduce((sum, e) => sum + e.value, 0);
  const pieData = entries.map((e) => ({
    name: e.key,
    value: e.value,
    fill: `var(--color-${e.key})`,
  }));

  return (
    <div className="flex items-center gap-6">
      <ChartContainer config={pieChartConfig} className="!aspect-auto h-48 w-48 shrink-0">
        <PieChart>
          <Pie
            data={pieData}
            dataKey="value"
            nameKey="name"
            cx="50%"
            cy="50%"
            innerRadius={45}
            outerRadius={75}
            paddingAngle={2}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                nameKey="name"
                formatter={(value) => formatCurrency(Number(value))}
              />
            }
          />
        </PieChart>
      </ChartContainer>
      <div className="space-y-2 text-sm">
        {entries.map((entry) => (
          <div key={entry.key} className="flex items-center gap-2">
            <span className="h-3 w-3 rounded-sm" style={{ backgroundColor: entry.color }} />
            <span className="text-muted-foreground">{entry.label}</span>
            <span className="ml-auto font-mono text-foreground">{formatCurrency(entry.value)}</span>
            <span className="w-12 text-right font-mono text-muted-foreground">
              {formatPercent((entry.value / total) * 100)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// --- Operation Table ---

function OperationTable({ data }: { data: OperationRow[] }) {
  if (!data || data.length === 0) {
    return <p className="text-sm text-muted-foreground">No operation data available</p>;
  }

  return (
    <div className="overflow-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th className="pb-2 font-medium">Operation</th>
            <th className="pb-2 text-right font-medium">Requests</th>
            <th className="pb-2 text-right font-medium">Cost</th>
            <th className="pb-2 text-right font-medium">Avg ms</th>
            <th className="pb-2 text-right font-medium">P95 ms</th>
          </tr>
        </thead>
        <tbody>
          {data.map((row) => (
            <tr key={row.operation} className="border-b border-border/50">
              <td className="py-2 font-medium text-foreground">{row.operation}</td>
              <td className="py-2 text-right font-mono text-muted-foreground">
                {formatNumber(row.request_count)}
              </td>
              <td className="py-2 text-right font-mono text-foreground">
                {formatCurrency(row.total_cost_usd)}
              </td>
              <td className="py-2 text-right font-mono text-muted-foreground">
                {formatDuration(row.avg_duration_ms)}
              </td>
              <td className="py-2 text-right font-mono text-muted-foreground">
                {formatDuration(row.p95_duration_ms)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// --- Model Comparison Table ---

type ModelSortKey =
  | 'request_count'
  | 'total_cost_usd'
  | 'cost_per_1k_output_tokens'
  | 'avg_duration_ms'
  | 'p95_duration_ms';

function ModelComparisonTable({ data }: { data: ModelRow[] }) {
  const [sortKey, setSortKey] = useState<ModelSortKey>('total_cost_usd');
  const [sortDesc, setSortDesc] = useState(true);

  const handleSort = useCallback(
    (key: ModelSortKey) => {
      if (sortKey === key) {
        setSortDesc((d) => !d);
      } else {
        setSortKey(key);
        setSortDesc(true);
      }
    },
    [sortKey],
  );

  const sorted = useMemo(() => {
    return [...data].sort((a, b) => {
      const aVal = a[sortKey] ?? 0;
      const bVal = b[sortKey] ?? 0;
      return sortDesc ? bVal - aVal : aVal - bVal;
    });
  }, [data, sortKey, sortDesc]);

  if (!data || data.length === 0) {
    return <p className="text-sm text-muted-foreground">No model data available</p>;
  }

  const SortIcon = ({ col }: { col: ModelSortKey }) => {
    if (sortKey !== col) return <ArrowUpDown className="ml-1 inline h-3 w-3 opacity-40" />;
    return sortDesc ? (
      <ChevronDown className="ml-1 inline h-3 w-3" />
    ) : (
      <ChevronUp className="ml-1 inline h-3 w-3" />
    );
  };

  return (
    <div className="overflow-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th className="pb-2 font-medium">Model</th>
            <th
              className="cursor-pointer pb-2 text-right font-medium"
              onClick={() => handleSort('request_count')}
            >
              Requests
              <SortIcon col="request_count" />
            </th>
            <th
              className="cursor-pointer pb-2 text-right font-medium"
              onClick={() => handleSort('total_cost_usd')}
            >
              Cost
              <SortIcon col="total_cost_usd" />
            </th>
            <th
              className="cursor-pointer pb-2 text-right font-medium"
              onClick={() => handleSort('cost_per_1k_output_tokens')}
            >
              $/1K out
              <SortIcon col="cost_per_1k_output_tokens" />
            </th>
            <th
              className="cursor-pointer pb-2 text-right font-medium"
              onClick={() => handleSort('avg_duration_ms')}
            >
              Avg ms
              <SortIcon col="avg_duration_ms" />
            </th>
            <th
              className="cursor-pointer pb-2 text-right font-medium"
              onClick={() => handleSort('p95_duration_ms')}
            >
              P95 ms
              <SortIcon col="p95_duration_ms" />
            </th>
            <th className="pb-2 text-right font-medium">Cache %</th>
            <th className="pb-2 text-right font-medium">Reasoning %</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const cachePercent =
              row.input_tokens > 0 ? (row.cache_read_input_tokens / row.input_tokens) * 100 : 0;
            const reasoningPercent =
              row.output_tokens > 0 ? (row.reasoning_tokens / row.output_tokens) * 100 : 0;
            return (
              <tr key={row.model} className="border-b border-border/50">
                <td className="py-2 font-medium text-foreground">{row.model}</td>
                <td className="py-2 text-right font-mono text-muted-foreground">
                  {formatNumber(row.request_count)}
                </td>
                <td className="py-2 text-right font-mono text-foreground">
                  {formatCurrency(row.total_cost_usd)}
                </td>
                <td className="py-2 text-right font-mono text-muted-foreground">
                  {row.cost_per_1k_output_tokens != null
                    ? formatCurrency(row.cost_per_1k_output_tokens)
                    : '-'}
                </td>
                <td className="py-2 text-right font-mono text-muted-foreground">
                  {formatDuration(row.avg_duration_ms)}
                </td>
                <td className="py-2 text-right font-mono text-muted-foreground">
                  {formatDuration(row.p95_duration_ms)}
                </td>
                <td className="py-2 text-right font-mono text-muted-foreground">
                  {cachePercent > 0 ? formatPercent(cachePercent) : '-'}
                </td>
                <td className="py-2 text-right font-mono text-muted-foreground">
                  {reasoningPercent > 0 ? formatPercent(reasoningPercent) : '-'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// --- Provider Breakdown Chart ---

function ProviderBreakdownChart({ data }: { data: ProviderRow[] }) {
  if (!data || data.length === 0) {
    return <p className="text-sm text-muted-foreground">No provider data available</p>;
  }

  const PROVIDER_COLORS = ['#8b5cf6', '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#ec4899'];
  const barData = data.map((row, i) => ({
    ...row,
    fill: PROVIDER_COLORS[i % PROVIDER_COLORS.length],
  }));

  return (
    <ChartContainer
      config={providerChartConfig}
      className="!aspect-auto w-full"
      style={{ height: Math.max(data.length * 40, 120) }}
    >
      <BarChart data={barData} layout="vertical" margin={{ left: 80 }}>
        <CartesianGrid strokeDasharray="3 3" horizontal={false} />
        <XAxis
          type="number"
          tickFormatter={(v: number) => formatCurrency(v)}
          tick={{ fontSize: 11 }}
        />
        <YAxis type="category" dataKey="provider" tick={{ fontSize: 12 }} width={75} />
        <ChartTooltip
          content={<ChartTooltipContent formatter={(value) => formatCurrency(Number(value))} />}
        />
        <Bar dataKey="total_cost_usd" radius={[0, 4, 4, 0]} />
      </BarChart>
    </ChartContainer>
  );
}

// --- Filter Dropdown ---

function FilterDropdown({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (val: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
      >
        {value || label}
        <ChevronDown className="h-3 w-3 text-muted-foreground" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-10 mt-1 max-h-48 w-40 overflow-auto rounded-lg border border-border bg-card py-1 shadow-lg">
          <button
            onClick={() => {
              onChange('');
              setOpen(false);
            }}
            className={`w-full px-3 py-1.5 text-left text-xs transition-colors hover:bg-muted ${
              !value ? 'bg-muted font-medium' : ''
            }`}
          >
            All {label}s
          </button>
          {options.map((opt) => (
            <button
              key={opt}
              onClick={() => {
                onChange(opt);
                setOpen(false);
              }}
              className={`w-full px-3 py-1.5 text-left text-xs transition-colors hover:bg-muted ${
                value === opt ? 'bg-muted font-medium' : ''
              }`}
            >
              {opt}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Main Usage Page ---

export default function Usage() {
  usePageHeader('Usage & Costs');

  const [timeRange, setTimeRange] = useState<TimeRange>('30d');
  const [metric, setMetric] = useState<TimeseriesMetric>('cost');
  const [providerFilter, setProviderFilter] = useState('');
  const [modelFilter, setModelFilter] = useState('');
  const [operationFilter, setOperationFilter] = useState('');

  const startTimeNs = useMemo(() => {
    const range = TIME_RANGES.find((r) => r.value === timeRange);
    return (Date.now() - (range?.ms ?? 0)) * 1_000_000;
  }, [timeRange]);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- Intentionally recalculate on timeRange change
  const endTimeNs = useMemo(() => Date.now() * 1_000_000, [timeRange]);

  const filterParams = useMemo(() => {
    const p: Record<string, string | number> = {
      start_time_ns: startTimeNs,
      end_time_ns: endTimeNs,
    };
    if (providerFilter) p.provider = providerFilter;
    if (modelFilter) p.model = modelFilter;
    if (operationFilter) p.baggage_operation = operationFilter;
    return p;
  }, [startTimeNs, endTimeNs, providerFilter, modelFilter, operationFilter]);

  const summaryQuery = useTinybirdPipe<TinybirdResponse<SummaryRow>>({
    pipe: 'llm_usage_summary',
    params: filterParams,
    transform: (r) => r as TinybirdResponse<SummaryRow>,
  });

  const timeseriesQuery = useTinybirdPipe<TinybirdResponse<TimeseriesRow>>({
    pipe: 'llm_usage_timeseries',
    params: filterParams,
    transform: (r) => r as TinybirdResponse<TimeseriesRow>,
  });

  const modelsQuery = useTinybirdPipe<TinybirdResponse<ModelRow>>({
    pipe: 'llm_usage_by_model',
    params: filterParams,
    transform: (r) => r as TinybirdResponse<ModelRow>,
  });

  const providersQuery = useTinybirdPipe<TinybirdResponse<ProviderRow>>({
    pipe: 'llm_usage_by_provider',
    params: filterParams,
    transform: (r) => r as TinybirdResponse<ProviderRow>,
  });

  const operationsQuery = useTinybirdPipe<TinybirdResponse<OperationRow>>({
    pipe: 'llm_usage_by_operation',
    params: filterParams,
    transform: (r) => r as TinybirdResponse<OperationRow>,
  });

  const isInitialRender = useRef(true);
  useEffect(() => {
    if (isInitialRender.current) {
      isInitialRender.current = false;
      return;
    }
    void summaryQuery.refetch();
    void timeseriesQuery.refetch();
    void modelsQuery.refetch();
    void providersQuery.refetch();
    void operationsQuery.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeRange, providerFilter, modelFilter, operationFilter]);

  const summary = summaryQuery.data?.data?.[0];
  const timeseries = timeseriesQuery.data?.data ?? [];
  const models = modelsQuery.data?.data ?? [];
  const providers = providersQuery.data?.data ?? [];
  const operations = operationsQuery.data?.data ?? [];

  const isLoading = [
    summaryQuery.loading,
    timeseriesQuery.loading,
    modelsQuery.loading,
    providersQuery.loading,
    operationsQuery.loading,
  ].some(Boolean);

  const hasError =
    summaryQuery.error ??
    timeseriesQuery.error ??
    modelsQuery.error ??
    providersQuery.error ??
    operationsQuery.error;

  // Accumulate filter options so they persist across filter changes
  const seenProviders = useRef(new Set<string>());
  const seenModels = useRef(new Set<string>());
  const seenOperations = useRef(new Set<string>());

  const prevTimeRange = useRef(timeRange);
  if (prevTimeRange.current !== timeRange) {
    seenProviders.current.clear();
    seenModels.current.clear();
    seenOperations.current.clear();
    prevTimeRange.current = timeRange;
  }

  providers.forEach((p) => seenProviders.current.add(p.provider));
  models.forEach((m) => seenModels.current.add(m.model));
  operations.forEach((o) => seenOperations.current.add(o.operation));

  const providerOptions = Array.from(seenProviders.current).sort();
  const modelOptions = Array.from(seenModels.current).sort();
  const operationOptions = Array.from(seenOperations.current).sort();

  const costPerRequest =
    summary && summary.request_count > 0 ? summary.total_cost_usd / summary.request_count : null;

  const cacheReadPercent =
    summary && summary.total_cost_usd > 0
      ? (summary.cache_read_cost_usd / summary.total_cost_usd) * 100
      : 0;

  return (
    <div className="animate-fade-in">
      {/* Header controls */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">Cost analytics deep-dive</p>
        <div className="flex items-center gap-2">
          {/* Time range toggle */}
          <div className="flex rounded-lg border border-border bg-card">
            {TIME_RANGES.map((range) => (
              <button
                key={range.value}
                onClick={() => setTimeRange(range.value)}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                  timeRange === range.value
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {range.label}
              </button>
            ))}
          </div>
          <FilterDropdown
            label="Provider"
            value={providerFilter}
            options={providerOptions}
            onChange={setProviderFilter}
          />
          <FilterDropdown
            label="Model"
            value={modelFilter}
            options={modelOptions}
            onChange={setModelFilter}
          />
          <FilterDropdown
            label="Operation"
            value={operationFilter}
            options={operationOptions}
            onChange={setOperationFilter}
          />
        </div>
      </div>

      {hasError && (
        <div className="mb-6 rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">
          Failed to load usage data. Please try refreshing.
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          Loading usage analytics...
        </div>
      ) : (
        <div className="space-y-8">
          {/* Summary Cards */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <SummaryCard
              icon={<Activity className="h-4 w-4" />}
              label="Requests"
              value={summary ? formatNumber(summary.request_count) : '-'}
              accent="purple"
            />
            <SummaryCard
              icon={<DollarSign className="h-4 w-4" />}
              label="Total Cost"
              value={summary ? formatCurrency(summary.total_cost_usd) : '-'}
              accent="blue"
            />
            <SummaryCard
              icon={<TrendingDown className="h-4 w-4" />}
              label="Cache Read Cost"
              value={summary ? formatCurrency(summary.cache_read_cost_usd) : '-'}
              subtitle={
                cacheReadPercent > 0 ? `${formatPercent(cacheReadPercent)} of spend` : undefined
              }
              accent="emerald"
            />
            <SummaryCard
              icon={<Layers className="h-4 w-4" />}
              label="Cost / Request"
              value={costPerRequest !== null ? formatCurrency(costPerRequest) : '-'}
              accent="amber"
            />
            <SummaryCard
              icon={<Timer className="h-4 w-4" />}
              label="Avg Latency"
              value={summary ? formatDuration(summary.avg_duration_ms) : '-'}
              subtitle={summary ? `P95: ${formatDuration(summary.p95_duration_ms)}` : undefined}
              accent="purple"
            />
          </div>

          {/* Cost Over Time */}
          <div className="rounded-xl border border-border bg-card p-6">
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <DollarSign className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-base font-medium text-foreground">Cost Over Time</h2>
              </div>
              <div className="flex rounded-lg border border-border bg-background">
                {(['cost', 'tokens', 'requests', 'latency'] as TimeseriesMetric[]).map((m) => (
                  <button
                    key={m}
                    onClick={() => setMetric(m)}
                    className={`px-3 py-1 text-xs font-medium capitalize transition-colors ${
                      metric === m
                        ? 'bg-primary/10 text-primary'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>
            {metric === 'cost' && (
              <div className="mb-3 flex flex-wrap gap-3 text-xs">
                {Object.entries(costChartConfig).map(([key, cfg]) => (
                  <span key={key} className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: cfg.color }} />
                    <span className="text-muted-foreground">{String(cfg.label)}</span>
                  </span>
                ))}
              </div>
            )}
            <CostTimeseriesChart data={timeseries} metric={metric} />
          </div>

          {/* Cost Breakdown + Operations (side by side) */}
          <div className="grid gap-6 lg:grid-cols-2">
            <div className="rounded-xl border border-border bg-card p-6">
              <div className="mb-4 flex items-center gap-2">
                <DollarSign className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-base font-medium text-foreground">Cost Breakdown</h2>
              </div>
              {summary ? (
                <CostBreakdownChart summary={summary} />
              ) : (
                <p className="text-sm text-muted-foreground">No cost data available</p>
              )}
            </div>

            <div className="rounded-xl border border-border bg-card p-6">
              <div className="mb-4 flex items-center gap-2">
                <Layers className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-base font-medium text-foreground">By Operation</h2>
              </div>
              <OperationTable data={operations} />
            </div>
          </div>

          {/* Model Comparison */}
          <div className="rounded-xl border border-border bg-card p-6">
            <div className="mb-4 flex items-center gap-2">
              <Cpu className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-base font-medium text-foreground">Model Comparison</h2>
            </div>
            <ModelComparisonTable data={models} />
          </div>

          {/* Provider Breakdown */}
          <div className="rounded-xl border border-border bg-card p-6">
            <div className="mb-4 flex items-center gap-2">
              <Server className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-base font-medium text-foreground">Provider Breakdown</h2>
            </div>
            <ProviderBreakdownChart data={providers} />
          </div>
        </div>
      )}
    </div>
  );
}
