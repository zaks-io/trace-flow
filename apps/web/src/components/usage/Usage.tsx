'use client';

import { useState, useMemo, useRef } from 'react';
import { type Preloaded, usePreloadedQuery, useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import {
  Activity,
  DollarSign,
  Hash,
  Layers,
  Server,
  Cpu,
  TrendingDown,
  Timer,
  Key,
} from 'lucide-react';
import { useTinybirdQuery } from '@/hooks/useTinybirdQuery';
import { snapToMinute } from '@/lib/tinybird';
import { useApiKeyMap } from '@/hooks/useApiKeyMap';
import { PageToolbar } from '@/components/PageToolbar';
import { formatNumber, formatCurrency, formatPercent, formatDuration } from '@/lib/format';
import {
  TIME_RANGES,
  costChartConfig,
  tokensChartConfig,
  requestsChartConfig,
  latencyChartConfig,
  type TimeRange,
  type TimeseriesMetric,
  type TinybirdResponse,
  type SummaryRow,
  type TimeseriesRow,
  type ModelRow,
  type ProviderRow,
  type OperationRow,
  type ApiKeyRow,
  type CostForecastRow,
} from './types';
import { SummaryCard } from './SummaryCard';
import { ProjectedCostCard } from './ProjectedCostCard';
import { CostTimeseriesChart } from './CostTimeseriesChart';
import { CostBreakdownChart } from './CostBreakdownChart';
import { OperationTable } from './OperationTable';
import { ModelComparisonTable } from './ModelComparisonTable';
import { ProviderBreakdownChart } from './ProviderBreakdownChart';
import { ApiKeyBreakdownTable } from './ApiKeyBreakdownTable';
import { FilterDropdown } from './FilterDropdown';

const METRIC_META = {
  cost: { label: 'Cost Over Time', icon: DollarSign, config: costChartConfig },
  tokens: { label: 'Tokens Over Time', icon: Hash, config: tokensChartConfig },
  requests: { label: 'Requests Over Time', icon: Activity, config: requestsChartConfig },
  latency: { label: 'Latency Over Time', icon: Timer, config: latencyChartConfig },
} satisfies Record<
  TimeseriesMetric,
  {
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    config: Record<string, { label: string; color: string }>;
  }
>;

export default function Usage({
  preloadedApiKeys,
}: {
  preloadedApiKeys: Preloaded<typeof api.apiKeys.list>;
}) {
  const billingSummary = useQuery(api.subscriptions.getBillingSummaryForCurrentUser);
  const [timeRange, setTimeRange] = useState<TimeRange>('30d');
  const [metric, setMetric] = useState<TimeseriesMetric>('cost');
  const [providerFilter, setProviderFilter] = useState('');
  const [modelFilter, setModelFilter] = useState('');
  const [operationFilter, setOperationFilter] = useState('');
  const [apiKeyFilter, setApiKeyFilter] = useState('');

  const apiKeys = usePreloadedQuery(preloadedApiKeys);
  const apiKeyMap = useApiKeyMap(apiKeys);

  const { startTimeNs, endTimeNs } = useMemo(() => {
    const range = TIME_RANGES.find((r) => r.value === timeRange);
    return {
      startTimeNs: snapToMinute(Date.now() - (range?.ms ?? 0)) * 1_000_000,
      endTimeNs: snapToMinute(Date.now()) * 1_000_000,
    };
  }, [timeRange]);

  const filterParams = useMemo(() => {
    const p: Record<string, string | number> = {
      start_time_ns: startTimeNs,
      end_time_ns: endTimeNs,
    };
    if (providerFilter) p.provider = providerFilter;
    if (modelFilter) p.model = modelFilter;
    if (operationFilter) p.baggage_operation = operationFilter;
    if (apiKeyFilter) p.api_key_filter = apiKeyFilter;
    return p;
  }, [startTimeNs, endTimeNs, providerFilter, modelFilter, operationFilter, apiKeyFilter]);

  const forecastParams = useMemo(() => {
    const p: Record<string, string> = {};
    if (providerFilter) p.provider = providerFilter;
    if (modelFilter) p.model = modelFilter;
    if (operationFilter) p.baggage_operation = operationFilter;
    if (apiKeyFilter) p.api_key_filter = apiKeyFilter;
    return p;
  }, [providerFilter, modelFilter, operationFilter, apiKeyFilter]);

  const summaryQuery = useTinybirdQuery<TinybirdResponse<SummaryRow>>({
    pipe: 'llm_usage_summary',
    params: filterParams,
  });

  const timeseriesQuery = useTinybirdQuery<TinybirdResponse<TimeseriesRow>>({
    pipe: 'llm_usage_timeseries',
    params: filterParams,
  });

  const modelsQuery = useTinybirdQuery<TinybirdResponse<ModelRow>>({
    pipe: 'llm_usage_by_model',
    params: filterParams,
  });

  const providersQuery = useTinybirdQuery<TinybirdResponse<ProviderRow>>({
    pipe: 'llm_usage_by_provider',
    params: filterParams,
  });

  const operationsQuery = useTinybirdQuery<TinybirdResponse<OperationRow>>({
    pipe: 'llm_usage_by_operation',
    params: filterParams,
  });

  const apiKeysQuery = useTinybirdQuery<TinybirdResponse<ApiKeyRow>>({
    pipe: 'llm_usage_by_api_key',
    params: filterParams,
  });

  const forecastQuery = useTinybirdQuery<TinybirdResponse<CostForecastRow>>({
    pipe: 'llm_cost_forecast',
    params: forecastParams,
  });

  const summary = summaryQuery.data?.data?.[0];
  const timeseries = timeseriesQuery.data?.data ?? [];
  const models = modelsQuery.data?.data ?? [];
  const providers = providersQuery.data?.data ?? [];
  const operations = operationsQuery.data?.data ?? [];
  const apiKeyRows = apiKeysQuery.data?.data ?? [];
  const forecast = forecastQuery.data?.data?.[0] ?? null;

  const isLoading = [
    summaryQuery.isLoading,
    timeseriesQuery.isLoading,
    modelsQuery.isLoading,
    providersQuery.isLoading,
    operationsQuery.isLoading,
    apiKeysQuery.isLoading,
    forecastQuery.isLoading,
  ].some(Boolean);

  const hasError =
    summaryQuery.error ??
    timeseriesQuery.error ??
    modelsQuery.error ??
    providersQuery.error ??
    operationsQuery.error ??
    apiKeysQuery.error ??
    forecastQuery.error;

  // Accumulate filter options so they persist across filter changes
  const seenProviders = useRef(new Set<string>());
  const seenModels = useRef(new Set<string>());
  const seenOperations = useRef(new Set<string>());
  const seenApiKeys = useRef(new Set<string>());

  const prevTimeRange = useRef(timeRange);
  if (prevTimeRange.current !== timeRange) {
    seenProviders.current.clear();
    seenModels.current.clear();
    seenOperations.current.clear();
    seenApiKeys.current.clear();
    prevTimeRange.current = timeRange;
  }

  providers.forEach((p) => seenProviders.current.add(p.provider));
  models.forEach((m) => seenModels.current.add(m.model));
  operations.forEach((o) => seenOperations.current.add(o.operation));
  apiKeyRows.forEach((k) => seenApiKeys.current.add(k.api_key));

  const providerOptions = Array.from(seenProviders.current).sort();
  const modelOptions = Array.from(seenModels.current).sort();
  const operationOptions = Array.from(seenOperations.current).sort();
  const apiKeyOptions = Array.from(seenApiKeys.current).sort();

  const costPerRequest =
    summary && summary.request_count > 0 ? summary.total_cost_usd / summary.request_count : null;

  const cacheReadPercent =
    summary && summary.total_cost_usd > 0
      ? (summary.cache_read_cost_usd / summary.total_cost_usd) * 100
      : 0;

  return (
    <div className="animate-fade-in">
      <PageToolbar>
        <p className="text-sm text-muted-foreground">LLM Request Analytics</p>
        <div className="flex-1" />
        <div className="flex items-center gap-2">
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
          <FilterDropdown
            label="API Key"
            value={apiKeyFilter}
            options={apiKeyOptions}
            onChange={setApiKeyFilter}
            labelMap={apiKeyMap}
          />
        </div>
      </PageToolbar>

      {hasError && (
        <div className="mb-6 rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">
          Failed to load usage data. Please try refreshing.
        </div>
      )}

      {billingSummary?.subscription && (
        <div className="mb-6 rounded-lg bg-card/40 p-4 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-muted-foreground">
              Billing status:{' '}
              <span className="font-medium text-foreground">
                {billingSummary.subscription.status ?? 'active'}
              </span>
              {' • '}Seats: {billingSummary.activeMembers}/
              {billingSummary.subscription.seatQuantity ?? 1}
              {' • '}Included units: {billingSummary.subscription.monthlyUnits.toLocaleString()}
              {billingSummary.currentPeriodEnd > 0 && (
                <>
                  {' • '}Resets: {new Date(billingSummary.currentPeriodEnd).toLocaleDateString()}
                </>
              )}
            </div>
            <a className="text-primary hover:underline" href="/app/settings/billing">
              Manage billing
            </a>
          </div>
          {billingSummary.totalAvailable > 0 && (
            <div className="mt-3">
              <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {billingSummary.totalUsed.toLocaleString()} /{' '}
                  {billingSummary.totalAvailable.toLocaleString()} units used
                </span>
                <span>{billingSummary.remaining.toLocaleString()} remaining</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={`h-full rounded-full transition-all ${
                    billingSummary.totalUsed / billingSummary.totalAvailable > 0.9
                      ? 'bg-red-500'
                      : billingSummary.totalUsed / billingSummary.totalAvailable > 0.7
                        ? 'bg-amber-500'
                        : 'bg-primary'
                  }`}
                  style={{
                    width: `${Math.min(100, (billingSummary.totalUsed / billingSummary.totalAvailable) * 100)}%`,
                  }}
                />
              </div>
            </div>
          )}
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
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
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
            <ProjectedCostCard forecast={forecast} />
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
          <div className="rounded-xl bg-card/40 p-6">
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                {(() => {
                  const Icon = METRIC_META[metric].icon;
                  return <Icon className="h-4 w-4 text-muted-foreground" />;
                })()}
                <h2 className="text-base font-medium text-foreground">
                  {METRIC_META[metric].label}
                </h2>
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
            <div className="mb-3 flex flex-wrap gap-3 text-xs">
              {Object.entries(METRIC_META[metric].config).map(([key, cfg]) => (
                <span key={key} className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: cfg.color }} />
                  <span className="text-muted-foreground">{String(cfg.label)}</span>
                </span>
              ))}
            </div>
            <CostTimeseriesChart data={timeseries} metric={metric} />
          </div>

          {/* Cost Breakdown + Operations (side by side) */}
          <div className="grid gap-6 lg:grid-cols-2">
            <div className="rounded-xl bg-card/40 p-6">
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

            <div className="rounded-xl bg-card/40 p-6">
              <div className="mb-4 flex items-center gap-2">
                <Layers className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-base font-medium text-foreground">By Operation</h2>
              </div>
              <OperationTable data={operations} />
            </div>
          </div>

          {/* Model Comparison */}
          <div className="rounded-xl bg-card/40 p-6">
            <div className="mb-4 flex items-center gap-2">
              <Cpu className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-base font-medium text-foreground">Model Comparison</h2>
            </div>
            <ModelComparisonTable data={models} />
          </div>

          {/* Provider Breakdown + API Key Breakdown (side by side) */}
          <div className="grid gap-6 lg:grid-cols-2">
            <div className="rounded-xl bg-card/40 p-6">
              <div className="mb-4 flex items-center gap-2">
                <Server className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-base font-medium text-foreground">Provider Breakdown</h2>
              </div>
              <ProviderBreakdownChart data={providers} />
            </div>

            <div className="rounded-xl bg-card/40 p-6">
              <div className="mb-4 flex items-center gap-2">
                <Key className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-base font-medium text-foreground">By API Key</h2>
              </div>
              <ApiKeyBreakdownTable data={apiKeyRows} apiKeyMap={apiKeyMap} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
