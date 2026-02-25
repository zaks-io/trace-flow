'use client';

import { useState, useMemo } from 'react';
import { type Preloaded, usePreloadedQuery } from 'convex/react';
import { type api } from '@convex/_generated/api';
import { Activity, Zap, Hash, ChevronDown, Cpu, Server, DollarSign, Key } from 'lucide-react';
import { useTinybirdQuery } from '@/hooks/useTinybirdQuery';
import { snapToMinute } from '@/lib/tinybird';
import { useApiKeyMap } from '@/hooks/useApiKeyMap';
import { PageToolbar } from '@/components/PageToolbar';
import { formatNumber, formatCurrency } from '@/lib/format';

type TimeRange = '24h' | '7d' | '30d';

const TIME_RANGES: { value: TimeRange; label: string; ms: number }[] = [
  { value: '24h', label: 'Last 24 hours', ms: 24 * 60 * 60 * 1000 },
  { value: '7d', label: 'Last 7 days', ms: 7 * 24 * 60 * 60 * 1000 },
  { value: '30d', label: 'Last 30 days', ms: 30 * 24 * 60 * 60 * 1000 },
];

interface SummaryData {
  data: {
    request_count: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
    reasoning_tokens: number;
    total_cost_usd: number;
    total_tokens: number;
    new_input_tokens: number;
  }[];
}

interface ModelData {
  data: {
    model: string;
    request_count: number;
    total_cost_usd: number;
    total_tokens: number;
  }[];
}

interface ProviderData {
  data: {
    provider: string;
    request_count: number;
    total_cost_usd: number;
    total_tokens: number;
  }[];
}

interface ApiKeyData {
  data: {
    api_key: string;
    request_count: number;
    total_cost_usd: number;
    total_tokens: number;
  }[];
}

interface TimeseriesData {
  data: {
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
  }[];
}

interface SummaryCardProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  accent?: 'purple' | 'blue' | 'emerald' | 'amber' | 'zinc' | 'red' | 'green';
}

const accentColors = {
  purple: 'from-purple-500/20 to-purple-500/5 border-purple-500/30',
  blue: 'from-blue-500/20 to-blue-500/5 border-blue-500/30',
  emerald: 'from-emerald-500/20 to-emerald-500/5 border-emerald-500/30',
  amber: 'from-amber-500/20 to-amber-500/5 border-amber-500/30',
  zinc: 'from-zinc-500/20 to-zinc-500/5 border-zinc-500/30',
  red: 'from-red-500/20 to-red-500/5 border-red-500/30',
  green: 'from-emerald-500/20 to-emerald-500/5 border-emerald-500/30',
};

const iconColors = {
  purple: 'text-purple-400',
  blue: 'text-blue-400',
  emerald: 'text-emerald-400',
  amber: 'text-amber-400',
  zinc: 'text-zinc-400',
  red: 'text-red-400',
  green: 'text-emerald-400',
};

function SummaryCard({ icon, label, value, accent = 'zinc' }: SummaryCardProps) {
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
        </div>
        <div className={`rounded-lg bg-background/50 p-2 ${iconColors[accent]}`}>{icon}</div>
      </div>
    </div>
  );
}

function formatBucketLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function UsageTimeseriesChart({ data }: { data: TimeseriesData['data'] }) {
  if (!data || data.length === 0) {
    return <p className="text-sm text-muted-foreground">No usage data available</p>;
  }

  const width = 640;
  const height = 180;
  const padding = 24;
  const usableWidth = width - padding * 2;
  const usableHeight = height - padding * 2;

  const tokens = data.map((point) => point.total_tokens ?? 0);
  const costs = data.map((point) => point.total_cost_usd ?? 0);
  const maxTokens = Math.max(...tokens, 1);
  const maxCost = Math.max(...costs, 1);

  const xStep = data.length > 1 ? usableWidth / (data.length - 1) : 0;

  const tokenPoints = data
    .map((point, index) => {
      const x = data.length === 1 ? width / 2 : padding + index * xStep;
      const y = height - padding - (tokens[index] / maxTokens) * usableHeight;
      return `${x},${y}`;
    })
    .join(' ');

  const costPoints = data
    .map((point, index) => {
      const x = data.length === 1 ? width / 2 : padding + index * xStep;
      const y = height - padding - (costs[index] / maxCost) * usableHeight;
      return `${x},${y}`;
    })
    .join(' ');

  const startLabel = formatBucketLabel(data[0]?.bucket_start ?? '');
  const endLabel = formatBucketLabel(data[data.length - 1]?.bucket_start ?? '');

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="flex items-center gap-2">
          <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" />
          Tokens
        </span>
        <span className="flex items-center gap-2">
          <span className="inline-block h-2 w-2 rounded-full bg-amber-400" />
          Cost
        </span>
      </div>
      <svg className="h-40 w-full" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        <polyline points={tokenPoints} fill="none" stroke="rgb(16 185 129)" strokeWidth="2" />
        <polyline points={costPoints} fill="none" stroke="rgb(251 191 36)" strokeWidth="2" />
      </svg>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{startLabel}</span>
        <span>{endLabel}</span>
      </div>
    </div>
  );
}

export default function Dashboard({
  preloadedApiKeys,
}: {
  preloadedApiKeys: Preloaded<typeof api.apiKeys.list>;
}) {
  const apiKeyList = usePreloadedQuery(preloadedApiKeys);
  const apiKeyMap = useApiKeyMap(apiKeyList);
  const [timeRange, setTimeRange] = useState<TimeRange>('30d');
  const [dropdownOpen, setDropdownOpen] = useState(false);

  const startTimeNs = useMemo(() => {
    const range = TIME_RANGES.find((r) => r.value === timeRange);
    return snapToMinute(Date.now() - (range?.ms ?? 0)) * 1_000_000;
  }, [timeRange]);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- Intentionally recalculate on timeRange change
  const endTimeNs = useMemo(() => snapToMinute(Date.now()) * 1_000_000, [timeRange]);

  // All queries now use Pipes with server-side API key filtering via JWT fixed_params
  const summaryQuery = useTinybirdQuery<SummaryData>({
    pipe: 'llm_usage_summary',
    params: { start_time_ns: startTimeNs, end_time_ns: endTimeNs },
  });

  const modelsQuery = useTinybirdQuery<ModelData>({
    pipe: 'llm_usage_by_model',
    params: { start_time_ns: startTimeNs, end_time_ns: endTimeNs },
  });

  const providersQuery = useTinybirdQuery<ProviderData>({
    pipe: 'llm_usage_by_provider',
    params: { start_time_ns: startTimeNs, end_time_ns: endTimeNs },
  });

  const apiKeysQuery = useTinybirdQuery<ApiKeyData>({
    pipe: 'llm_usage_by_api_key',
    params: { start_time_ns: startTimeNs, end_time_ns: endTimeNs },
  });

  const timeseriesQuery = useTinybirdQuery<TimeseriesData>({
    pipe: 'llm_usage_timeseries',
    params: { start_time_ns: startTimeNs, end_time_ns: endTimeNs },
  });

  const summary = summaryQuery.data?.data?.[0];
  const models = modelsQuery.data?.data ?? [];
  const providers = providersQuery.data?.data ?? [];
  const apiKeys = apiKeysQuery.data?.data ?? [];
  const timeseries = timeseriesQuery.data?.data ?? [];

  const isLoading =
    summaryQuery.isLoading ||
    modelsQuery.isLoading ||
    providersQuery.isLoading ||
    apiKeysQuery.isLoading ||
    timeseriesQuery.isLoading;
  const hasError =
    summaryQuery.error ??
    modelsQuery.error ??
    providersQuery.error ??
    apiKeysQuery.error ??
    timeseriesQuery.error;

  const selectedRangeLabel = TIME_RANGES.find((r) => r.value === timeRange)?.label;

  return (
    <div className="animate-fade-in">
      <PageToolbar>
        <p className="text-sm text-muted-foreground">LLM Request Analytics Overview</p>
        <div className="flex-1" />
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
      </PageToolbar>

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
              value={summary ? formatNumber(summary.request_count) : '-'}
              accent="purple"
            />
            <SummaryCard
              icon={<Cpu className="h-4 w-4" />}
              label="Input Tokens"
              value={summary ? formatNumber(summary.input_tokens) : '-'}
              accent="blue"
            />
            <SummaryCard
              icon={<Zap className="h-4 w-4" />}
              label="Output Tokens"
              value={summary ? formatNumber(summary.output_tokens) : '-'}
              accent="amber"
            />
            <SummaryCard
              icon={<Server className="h-4 w-4" />}
              label="Cached Tokens"
              value={summary ? formatNumber(summary.cache_read_input_tokens) : '-'}
              accent="zinc"
            />
            <SummaryCard
              icon={<Hash className="h-4 w-4" />}
              label="Total Tokens"
              value={summary ? formatNumber(summary.total_tokens) : '-'}
              accent="emerald"
            />
            <SummaryCard
              icon={<DollarSign className="h-4 w-4" />}
              label="Total Cost"
              value={summary ? formatCurrency(summary.total_cost_usd) : '-'}
              accent="green"
            />
          </div>

          <div className="rounded-xl border border-border bg-card p-6">
            <div className="mb-4 flex items-center gap-2">
              <Activity className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-base font-medium text-foreground">Usage Over Time</h2>
            </div>
            <UsageTimeseriesChart data={timeseries} />
          </div>

          {/* Breakdown Sections */}
          <div className="grid gap-6 lg:grid-cols-3">
            {/* Models Breakdown */}
            <div className="rounded-xl border border-border bg-card p-6">
              <div className="mb-4 flex items-center gap-2">
                <Cpu className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-base font-medium text-foreground">Models by Cost</h2>
              </div>
              {models.length === 0 ? (
                <p className="text-sm text-muted-foreground">No model data available</p>
              ) : (
                <div className="space-y-3">
                  {models.map((model) => {
                    const maxCost = models[0]?.total_cost_usd ?? 1;
                    const percentage = maxCost > 0 ? (model.total_cost_usd / maxCost) * 100 : 0;
                    return (
                      <div key={model.model} className="group">
                        <div className="mb-1 flex items-center justify-between text-sm">
                          <span className="truncate font-medium text-foreground">
                            {model.model}
                          </span>
                          <span className="ml-2 shrink-0 text-right font-mono text-muted-foreground">
                            {formatCurrency(model.total_cost_usd)} ·{' '}
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
                <h2 className="text-base font-medium text-foreground">Providers by Cost</h2>
              </div>
              {providers.length === 0 ? (
                <p className="text-sm text-muted-foreground">No provider data available</p>
              ) : (
                <div className="space-y-3">
                  {providers.map((provider) => {
                    const maxCost = providers[0]?.total_cost_usd ?? 1;
                    const percentage = maxCost > 0 ? (provider.total_cost_usd / maxCost) * 100 : 0;
                    return (
                      <div key={provider.provider} className="group">
                        <div className="mb-1 flex items-center justify-between text-sm">
                          <span className="font-medium capitalize text-foreground">
                            {provider.provider}
                          </span>
                          <span className="ml-2 shrink-0 text-right font-mono text-muted-foreground">
                            {formatCurrency(provider.total_cost_usd)} ·{' '}
                            {formatNumber(provider.request_count)}
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

            {/* API Keys Breakdown */}
            <div className="rounded-xl border border-border bg-card p-6">
              <div className="mb-4 flex items-center gap-2">
                <Key className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-base font-medium text-foreground">API Keys by Cost</h2>
              </div>
              {apiKeys.length === 0 ? (
                <p className="text-sm text-muted-foreground">No API key data available</p>
              ) : (
                <div className="space-y-3">
                  {apiKeys.map((row) => {
                    const maxCost = apiKeys[0]?.total_cost_usd ?? 1;
                    const percentage = maxCost > 0 ? (row.total_cost_usd / maxCost) * 100 : 0;
                    return (
                      <div key={row.api_key} className="group">
                        <div className="mb-1 flex items-center justify-between text-sm">
                          <span className="truncate font-medium text-foreground">
                            {apiKeyMap.get(row.api_key) ?? row.api_key}
                          </span>
                          <span className="ml-2 shrink-0 text-right font-mono text-muted-foreground">
                            {formatCurrency(row.total_cost_usd)} · {formatNumber(row.request_count)}
                          </span>
                        </div>
                        <div className="h-2 overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full rounded-full bg-amber-500 transition-all"
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
