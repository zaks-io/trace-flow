import { useState, useMemo, useEffect, useRef } from 'react';
import {
  Activity,
  GitBranch,
  Zap,
  Clock,
  AlertTriangle,
  Hash,
  ChevronDown,
  Cpu,
  Server,
} from 'lucide-react';
import { useTinybirdQuery } from '@/hooks/useTinybirdQuery';

type TimeRange = '24h' | '7d' | '30d';

const TIME_RANGES: { value: TimeRange; label: string; ms: number }[] = [
  { value: '24h', label: 'Last 24 hours', ms: 24 * 60 * 60 * 1000 },
  { value: '7d', label: 'Last 7 days', ms: 7 * 24 * 60 * 60 * 1000 },
  { value: '30d', label: 'Last 30 days', ms: 30 * 24 * 60 * 60 * 1000 },
];

interface SummaryData {
  data: {
    total_requests: number;
    total_traces: number;
    avg_ttft_ms: number | null;
    avg_duration_ms: number | null;
    error_rate_percent: number | null;
    total_input_tokens: number;
    total_output_tokens: number;
  }[];
}

interface ModelData {
  data: {
    model: string;
    request_count: number;
  }[];
}

interface ProviderData {
  data: {
    provider: string;
    request_count: number;
  }[];
}

interface SummaryCardProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  accent?: 'purple' | 'blue' | 'emerald' | 'amber' | 'zinc' | 'red';
}

function SummaryCard({ icon, label, value, accent = 'zinc' }: SummaryCardProps) {
  const accentColors = {
    purple: 'from-purple-500/20 to-purple-500/5 border-purple-500/30',
    blue: 'from-blue-500/20 to-blue-500/5 border-blue-500/30',
    emerald: 'from-emerald-500/20 to-emerald-500/5 border-emerald-500/30',
    amber: 'from-amber-500/20 to-amber-500/5 border-amber-500/30',
    zinc: 'from-zinc-500/20 to-zinc-500/5 border-zinc-500/30',
    red: 'from-red-500/20 to-red-500/5 border-red-500/30',
  };

  const iconColors = {
    purple: 'text-purple-400',
    blue: 'text-blue-400',
    emerald: 'text-emerald-400',
    amber: 'text-amber-400',
    zinc: 'text-zinc-400',
    red: 'text-red-400',
  };

  return (
    <div
      className={`relative overflow-hidden rounded-xl border bg-gradient-to-br p-4 ${accentColors[accent]}`}
    >
      <div className="flex items-start justify-between">
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {label}
          </p>
          <p className="mt-1 font-mono text-2xl font-semibold tabular-nums text-foreground">
            {value}
          </p>
        </div>
        <div className={`rounded-lg bg-background/50 p-2 ${iconColors[accent]}`}>{icon}</div>
      </div>
    </div>
  );
}

function formatNumber(num: number): string {
  if (num >= 1_000_000) {
    return `${(num / 1_000_000).toFixed(1)}M`;
  }
  if (num >= 1_000) {
    return `${(num / 1_000).toFixed(1)}K`;
  }
  return new Intl.NumberFormat().format(num);
}

function formatDuration(ms: number | null): string {
  if (ms === null || isNaN(ms)) return '-';
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatPercent(value: number | null): string {
  if (value === null || isNaN(value)) return '-';
  return `${value.toFixed(1)}%`;
}

export default function Dashboard() {
  const [timeRange, setTimeRange] = useState<TimeRange>('30d');
  const [dropdownOpen, setDropdownOpen] = useState(false);

  const startTimeNs = useMemo(() => {
    const range = TIME_RANGES.find((r) => r.value === timeRange);
    return (Date.now() - (range?.ms ?? 0)) * 1_000_000;
  }, [timeRange]);

  const summaryQuery = useTinybirdQuery<SummaryData>({
    sql: `
      SELECT
        countIf(ParentSpanId = '') as total_requests,
        count() as total_traces,
        avgIf(
          JSONExtractFloat(SpanAttributes, 'llm.time_to_first_token_ms'),
          SpanName = 'llm.request.ttft'
        ) as avg_ttft_ms,
        avgIf(Duration, ParentSpanId = '') / 1000000 as avg_duration_ms,
        countIf(StatusCode = 'STATUS_CODE_ERROR' AND ParentSpanId = '') * 100.0 /
          nullIf(countIf(ParentSpanId = ''), 0) as error_rate_percent,
        sumIf(
          coalesce(JSONExtractInt(SpanAttributes, 'llm.tokens.prompt'), 0) +
          coalesce(JSONExtractInt(SpanAttributes, 'llm.tokens.input'), 0) +
          coalesce(JSONExtractInt(SpanAttributes, 'gen_ai.usage.input_tokens'), 0),
          ParentSpanId = ''
        ) as total_input_tokens,
        sumIf(
          coalesce(JSONExtractInt(SpanAttributes, 'llm.tokens.completion'), 0) +
          coalesce(JSONExtractInt(SpanAttributes, 'llm.tokens.output'), 0) +
          coalesce(JSONExtractInt(SpanAttributes, 'gen_ai.usage.output_tokens'), 0),
          ParentSpanId = ''
        ) as total_output_tokens
      FROM otel_traces
      WHERE ReceivedAt >= ${startTimeNs}
      FORMAT JSON
    `,
    scopes: [{ type: 'DATASOURCES:READ', resource: 'otel_traces' }],
  });

  const modelsQuery = useTinybirdQuery<ModelData>({
    sql: `
      SELECT
        JSONExtractString(SpanAttributes, 'llm.model') as model,
        count() as request_count
      FROM otel_traces
      WHERE ParentSpanId = ''
        AND ReceivedAt >= ${startTimeNs}
        AND JSONExtractString(SpanAttributes, 'llm.model') != ''
      GROUP BY model
      ORDER BY request_count DESC
      LIMIT 10
      FORMAT JSON
    `,
    scopes: [{ type: 'DATASOURCES:READ', resource: 'otel_traces' }],
  });

  const providersQuery = useTinybirdQuery<ProviderData>({
    sql: `
      SELECT
        JSONExtractString(SpanAttributes, 'llm.provider') as provider,
        count() as request_count
      FROM otel_traces
      WHERE ParentSpanId = ''
        AND ReceivedAt >= ${startTimeNs}
        AND JSONExtractString(SpanAttributes, 'llm.provider') != ''
      GROUP BY provider
      ORDER BY request_count DESC
      FORMAT JSON
    `,
    scopes: [{ type: 'DATASOURCES:READ', resource: 'otel_traces' }],
  });

  // Track if this is the initial render to avoid double-fetching
  const isInitialRender = useRef(true);

  // Refetch all queries when time range changes
  useEffect(() => {
    if (isInitialRender.current) {
      isInitialRender.current = false;
      return;
    }
    void summaryQuery.refetch();
    void modelsQuery.refetch();
    void providersQuery.refetch();
  }, [timeRange]);

  const summary = summaryQuery.data?.data?.[0];
  const models = modelsQuery.data?.data ?? [];
  const providers = providersQuery.data?.data ?? [];
  const totalProviderRequests = providers.reduce(
    (sum: number, p): number => sum + Number(p.request_count ?? 0),
    0,
  );

  const isLoading =
    summaryQuery.loading === true ||
    modelsQuery.loading === true ||
    providersQuery.loading === true;
  const hasError = summaryQuery.error ?? modelsQuery.error ?? providersQuery.error;

  const selectedRangeLabel = TIME_RANGES.find((r) => r.value === timeRange)?.label;

  return (
    <div className="animate-fade-in">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Dashboard</h1>
          <p className="mt-1 text-sm text-muted-foreground">LLM Request Analytics Overview</p>
        </div>
        <div className="relative">
          <button
            onClick={() => setDropdownOpen(!dropdownOpen)}
            className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted"
          >
            {selectedRangeLabel}
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          </button>
          {dropdownOpen && (
            <div className="absolute right-0 top-full z-10 mt-1 w-40 rounded-lg border border-border bg-card py-1 shadow-lg">
              {TIME_RANGES.map((range) => (
                <button
                  key={range.value}
                  onClick={() => {
                    setTimeRange(range.value);
                    setDropdownOpen(false);
                  }}
                  className={`w-full px-3 py-2 text-left text-sm transition-colors hover:bg-muted ${
                    timeRange === range.value ? 'bg-muted font-medium' : ''
                  }`}
                >
                  {range.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {hasError && (
        <div className="mb-6 rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">
          Failed to load dashboard data. Please try refreshing.
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          Loading analytics...
        </div>
      ) : (
        <div className="space-y-8">
          {/* Summary Cards */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <SummaryCard
              icon={<Activity className="h-4 w-4" />}
              label="Total Requests"
              value={summary ? formatNumber(summary.total_requests) : '-'}
              accent="purple"
            />
            <SummaryCard
              icon={<GitBranch className="h-4 w-4" />}
              label="Total Traces"
              value={summary ? formatNumber(summary.total_traces) : '-'}
              accent="blue"
            />
            <SummaryCard
              icon={<Zap className="h-4 w-4" />}
              label="Avg TTFT"
              value={formatDuration(summary?.avg_ttft_ms ?? null)}
              accent="amber"
            />
            <SummaryCard
              icon={<Clock className="h-4 w-4" />}
              label="Avg Duration"
              value={formatDuration(summary?.avg_duration_ms ?? null)}
              accent="zinc"
            />
            <SummaryCard
              icon={<AlertTriangle className="h-4 w-4" />}
              label="Error Rate"
              value={formatPercent(summary?.error_rate_percent ?? null)}
              accent="red"
            />
            <SummaryCard
              icon={<Hash className="h-4 w-4" />}
              label="Total Tokens"
              value={
                summary
                  ? formatNumber(summary.total_input_tokens + summary.total_output_tokens)
                  : '-'
              }
              accent="emerald"
            />
          </div>

          {/* Breakdown Sections */}
          <div className="grid gap-6 lg:grid-cols-2">
            {/* Models Breakdown */}
            <div className="rounded-xl border border-border bg-card p-6">
              <div className="mb-4 flex items-center gap-2">
                <Cpu className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-base font-medium text-foreground">Models by Request Count</h2>
              </div>
              {models.length === 0 ? (
                <p className="text-sm text-muted-foreground">No model data available</p>
              ) : (
                <div className="space-y-3">
                  {models.map((model) => {
                    const maxCount = models[0]?.request_count ?? 1;
                    const percentage = (model.request_count / maxCount) * 100;
                    return (
                      <div key={model.model} className="group">
                        <div className="mb-1 flex items-center justify-between text-sm">
                          <span className="truncate font-medium text-foreground">
                            {model.model}
                          </span>
                          <span className="ml-2 shrink-0 font-mono text-muted-foreground">
                            {formatNumber(model.request_count)}
                          </span>
                        </div>
                        <div className="h-2 overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full rounded-full bg-purple-500 transition-all"
                            style={{ width: `${percentage}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Provider Breakdown */}
            <div className="rounded-xl border border-border bg-card p-6">
              <div className="mb-4 flex items-center gap-2">
                <Server className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-base font-medium text-foreground">Providers</h2>
              </div>
              {providers.length === 0 ? (
                <p className="text-sm text-muted-foreground">No provider data available</p>
              ) : (
                <div className="space-y-3">
                  {providers.map((provider) => {
                    const percentage =
                      totalProviderRequests > 0
                        ? (provider.request_count / totalProviderRequests) * 100
                        : 0;
                    return (
                      <div key={provider.provider} className="group">
                        <div className="mb-1 flex items-center justify-between text-sm">
                          <span className="font-medium capitalize text-foreground">
                            {provider.provider}
                          </span>
                          <span className="ml-2 shrink-0 font-mono text-muted-foreground">
                            {formatNumber(provider.request_count)}{' '}
                            <span className="text-xs">({percentage.toFixed(1)}%)</span>
                          </span>
                        </div>
                        <div className="h-2 overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full rounded-full bg-blue-500 transition-all"
                            style={{ width: `${percentage}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
