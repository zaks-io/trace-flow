'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { type Preloaded, usePreloadedQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import { ArrowUpDown, ChevronDown, ChevronUp, Database, Layers, Users } from 'lucide-react';
import { useTinybirdQuery } from '@/hooks/useTinybirdQuery';
import { useApiKeyMap } from '@/hooks/useApiKeyMap';
import { PageToolbar } from '@/components/PageToolbar';
import { BarCard, formatCostCompact } from '@/components/BarCard';
import { FilterDropdown } from '@/components/usage/FilterDropdown';
import {
  TIME_RANGES,
  type TimeRange,
  type TinybirdResponse,
  type OperationLeaderboardRow,
  type OperationUserRow,
  type OperationsFilterOptionsRow,
} from '@/components/usage/types';
import { Input } from '@/components/ui/input';
import { formatCurrency, formatDuration, formatNumber } from '@/lib/format';
import { getAggregateCacheHitRate, getCostPerRequest } from '@/lib/operations';
import { formatCacheHitRate, getCacheHitRateAccent } from '@/lib/cacheMetrics';
import { snapToMinute } from '@/lib/tinybird';

type LeaderboardSortKey =
  | 'request_count'
  | 'total_cost_usd'
  | 'cost_per_request'
  | 'cache_hit_rate'
  | 'avg_duration_ms'
  | 'p95_duration_ms';

function SortIcon({ col, sortKey, sortDesc }: { col: string; sortKey: string; sortDesc: boolean }) {
  if (sortKey !== col) return <ArrowUpDown className="ml-1 inline h-3 w-3 opacity-40" />;
  return sortDesc ? (
    <ChevronDown className="ml-1 inline h-3 w-3" />
  ) : (
    <ChevronUp className="ml-1 inline h-3 w-3" />
  );
}

function ProportionBar({ value, max }: { value: number; max: number }) {
  if (max === 0 || value === 0) return null;
  const pct = Math.min((value / max) * 100, 100);
  return (
    <div className="absolute inset-y-0 left-0 opacity-[0.06]" style={{ width: `${pct}%` }}>
      <div className="h-full bg-foreground" />
    </div>
  );
}

const CACHE_RATE_COLORS = {
  green: 'text-emerald-500',
  amber: 'text-amber-500',
  red: 'text-red-400',
  zinc: 'text-muted-foreground',
} as const;

function OperationsLeaderboardTable({
  data,
  selectedOperation,
  onSelectOperation,
  sortKey,
  sortDesc,
  onSort,
}: {
  data: OperationLeaderboardRow[];
  selectedOperation: string;
  onSelectOperation: (operation: string) => void;
  sortKey: LeaderboardSortKey;
  sortDesc: boolean;
  onSort: (key: LeaderboardSortKey) => void;
}) {
  if (data.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-12 text-center">
        <Layers className="h-8 w-8 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">No operation data available for this range.</p>
      </div>
    );
  }

  const maxRequests = Math.max(...data.map((r) => r.request_count));

  const cols: { key: LeaderboardSortKey; label: string }[] = [
    { key: 'request_count', label: 'Requests' },
    { key: 'total_cost_usd', label: 'Cost' },
    { key: 'cost_per_request', label: 'Cost / Req' },
    { key: 'cache_hit_rate', label: 'Cache Hit' },
    { key: 'avg_duration_ms', label: 'Avg' },
    { key: 'p95_duration_ms', label: 'P95' },
  ];

  return (
    <div className="overflow-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th className="pb-2 pl-3 font-medium">Operation</th>
            {cols.map((col) => (
              <th
                key={col.key}
                className="cursor-pointer select-none pb-2 text-right font-medium transition-colors hover:text-foreground"
                onClick={() => onSort(col.key)}
              >
                {col.label}
                <SortIcon col={col.key} sortKey={sortKey} sortDesc={sortDesc} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row) => {
            const isSelected = row.operation === selectedOperation;
            const cacheHitRate = getAggregateCacheHitRate(row);
            const costPerRequest = getCostPerRequest(row);
            const cacheAccent = getCacheHitRateAccent(cacheHitRate);

            return (
              <tr
                key={row.operation}
                onClick={() => onSelectOperation(row.operation)}
                className={`group relative cursor-pointer border-b border-border/50 transition-colors ${
                  isSelected ? 'bg-primary/5 hover:bg-primary/8' : 'hover:bg-muted/30'
                }`}
              >
                <td className="relative py-2.5 pl-3 font-medium text-foreground">
                  <ProportionBar value={row.request_count} max={maxRequests} />
                  {isSelected && (
                    <span className="absolute inset-y-0 left-0 w-[3px] rounded-r bg-primary" />
                  )}
                  <span className="relative z-10">{row.operation}</span>
                </td>
                <td className="py-2.5 text-right font-mono text-muted-foreground">
                  {formatNumber(row.request_count)}
                </td>
                <td className="py-2.5 text-right font-mono text-foreground">
                  {formatCurrency(row.total_cost_usd)}
                </td>
                <td className="py-2.5 text-right font-mono text-muted-foreground">
                  {formatCurrency(costPerRequest)}
                </td>
                <td className={`py-2.5 text-right font-mono ${CACHE_RATE_COLORS[cacheAccent]}`}>
                  {formatCacheHitRate(cacheHitRate)}
                </td>
                <td className="py-2.5 text-right font-mono text-muted-foreground">
                  {formatDuration(row.avg_duration_ms)}
                </td>
                <td className="py-2.5 text-right font-mono text-muted-foreground">
                  {formatDuration(row.p95_duration_ms)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function OperationUsersTable({ data }: { data: OperationUserRow[] }) {
  if (data.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-12 text-center">
        <Users className="h-8 w-8 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">
          No <code className="rounded bg-muted px-1 py-0.5 text-xs">baggage.userId</code> values
          were captured for this operation.
        </p>
      </div>
    );
  }

  const maxRequests = Math.max(...data.map((r) => r.request_count));

  return (
    <div className="overflow-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th className="pb-2 pl-3 font-medium">User ID</th>
            <th className="pb-2 text-right font-medium">Requests</th>
            <th className="pb-2 text-right font-medium">Cost</th>
            <th className="pb-2 text-right font-medium">Cost / Req</th>
            <th className="pb-2 text-right font-medium">Cache Hit</th>
            <th className="pb-2 text-right font-medium">Avg</th>
            <th className="pb-2 text-right font-medium">P95</th>
          </tr>
        </thead>
        <tbody>
          {data.map((row) => {
            const cacheHitRate = getAggregateCacheHitRate(row);
            const costPerRequest = getCostPerRequest(row);
            const cacheAccent = getCacheHitRateAccent(cacheHitRate);

            return (
              <tr
                key={row.baggage_user_id}
                className="relative border-b border-border/50 transition-colors hover:bg-muted/30"
              >
                <td className="relative py-2.5 pl-3 font-mono text-foreground">
                  <ProportionBar value={row.request_count} max={maxRequests} />
                  <span className="relative z-10">{row.baggage_user_id}</span>
                </td>
                <td className="py-2.5 text-right font-mono text-muted-foreground">
                  {formatNumber(row.request_count)}
                </td>
                <td className="py-2.5 text-right font-mono text-foreground">
                  {formatCurrency(row.total_cost_usd)}
                </td>
                <td className="py-2.5 text-right font-mono text-muted-foreground">
                  {formatCurrency(costPerRequest)}
                </td>
                <td className={`py-2.5 text-right font-mono ${CACHE_RATE_COLORS[cacheAccent]}`}>
                  {formatCacheHitRate(cacheHitRate)}
                </td>
                <td className="py-2.5 text-right font-mono text-muted-foreground">
                  {formatDuration(row.avg_duration_ms)}
                </td>
                <td className="py-2.5 text-right font-mono text-muted-foreground">
                  {formatDuration(row.p95_duration_ms)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function OperationsAnalytics({
  preloadedApiKeys,
}: {
  preloadedApiKeys: Preloaded<typeof api.apiKeys.list>;
}) {
  const [timeRange, setTimeRange] = useState<TimeRange>('30d');
  const [providerFilter, setProviderFilter] = useState('');
  const [modelFilter, setModelFilter] = useState('');
  const [operationFilter, setOperationFilter] = useState('');
  const [selectedOperationName, setSelectedOperationName] = useState('');
  const [apiKeyFilter, setApiKeyFilter] = useState('');
  const [userIdFilter, setUserIdFilter] = useState('');
  const [sortKey, setSortKey] = useState<LeaderboardSortKey>('total_cost_usd');
  const [sortDesc, setSortDesc] = useState(true);

  const apiKeys = usePreloadedQuery(preloadedApiKeys);
  const apiKeyMap = useApiKeyMap(apiKeys);
  const trimmedUserId = userIdFilter.trim();
  const [debouncedUserId, setDebouncedUserId] = useState(trimmedUserId);

  useEffect(() => {
    const id = setTimeout(() => setDebouncedUserId(trimmedUserId), 300);
    return () => clearTimeout(id);
  }, [trimmedUserId]);

  const { startTimeNs, endTimeNs } = useMemo(() => {
    const rangeMs = TIME_RANGES.find((range) => range.value === timeRange)?.ms ?? 0;
    const now = Date.now();

    return {
      startTimeNs: snapToMinute(now - rangeMs) * 1_000_000,
      endTimeNs: snapToMinute(now) * 1_000_000,
    };
  }, [timeRange]);

  const filterParams = useMemo(() => {
    const params: Record<string, string | number> = {
      start_time_ns: startTimeNs,
      end_time_ns: endTimeNs,
    };

    if (providerFilter) params.provider = providerFilter;
    if (modelFilter) params.model = modelFilter;
    if (operationFilter) params.baggage_operation = operationFilter;
    if (apiKeyFilter) params.api_key_filter = apiKeyFilter;
    if (debouncedUserId) params.baggage_user_id = debouncedUserId;

    return params;
  }, [
    apiKeyFilter,
    endTimeNs,
    modelFilter,
    operationFilter,
    providerFilter,
    startTimeNs,
    debouncedUserId,
  ]);

  const activeOperation = operationFilter || selectedOperationName;

  const operationsQuery = useTinybirdQuery<TinybirdResponse<OperationLeaderboardRow>>({
    pipe: 'operations_leaderboard',
    params: { ...filterParams, limit: 100 },
  });

  const usersQuery = useTinybirdQuery<TinybirdResponse<OperationUserRow>>({
    pipe: 'operation_user_breakdown',
    params: { ...filterParams, baggage_operation: activeOperation, limit: 50 },
    enabled: activeOperation !== '',
  });

  const filterOptionsQuery = useTinybirdQuery<TinybirdResponse<OperationsFilterOptionsRow>>({
    pipe: 'operations_filter_options',
    params: filterParams,
  });

  const operations = useMemo(() => operationsQuery.data?.data ?? [], [operationsQuery.data]);
  const users = usersQuery.data?.data ?? [];
  const filterOptions = filterOptionsQuery.data?.data?.[0];

  const isInitialLoading = operationsQuery.isLoading || filterOptionsQuery.isLoading;
  const isUsersLoading = usersQuery.isLoading;
  const hasError = operationsQuery.error ?? usersQuery.error ?? filterOptionsQuery.error;

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

  filterOptions?.providers.forEach((provider) => seenProviders.current.add(provider));
  filterOptions?.models.forEach((model) => seenModels.current.add(model));
  filterOptions?.operations.forEach((operation) => seenOperations.current.add(operation));
  filterOptions?.api_keys.forEach((apiKey) => seenApiKeys.current.add(apiKey));
  operations.forEach((row) => seenOperations.current.add(row.operation));

  if (providerFilter) seenProviders.current.add(providerFilter);
  if (modelFilter) seenModels.current.add(modelFilter);
  if (operationFilter) seenOperations.current.add(operationFilter);
  if (apiKeyFilter) seenApiKeys.current.add(apiKeyFilter);

  const providerOptions = Array.from(seenProviders.current).sort();
  const modelOptions = Array.from(seenModels.current).sort();
  const operationOptions = Array.from(seenOperations.current).sort();
  const apiKeyOptions = Array.from(seenApiKeys.current).sort();

  const selectedOperation = operations.find((row) => row.operation === activeOperation) ?? null;

  function handleSort(key: LeaderboardSortKey) {
    if (sortKey === key) {
      setSortDesc((d) => !d);
    } else {
      setSortKey(key);
      setSortDesc(true);
    }
  }

  const sortedOperations = useMemo(() => {
    return [...operations].sort((a, b) => {
      let aVal: number;
      let bVal: number;

      if (sortKey === 'cost_per_request') {
        aVal = getCostPerRequest(a) ?? 0;
        bVal = getCostPerRequest(b) ?? 0;
      } else if (sortKey === 'cache_hit_rate') {
        aVal = getAggregateCacheHitRate(a) ?? -1;
        bVal = getAggregateCacheHitRate(b) ?? -1;
      } else {
        aVal = a[sortKey] ?? 0;
        bVal = b[sortKey] ?? 0;
      }

      return sortDesc ? bVal - aVal : aVal - bVal;
    });
  }, [operations, sortKey, sortDesc]);

  function clearFilters() {
    setProviderFilter('');
    setModelFilter('');
    setOperationFilter('');
    setSelectedOperationName('');
    setApiKeyFilter('');
    setUserIdFilter('');
  }

  const hasActiveFilters =
    providerFilter || modelFilter || operationFilter || apiKeyFilter || trimmedUserId;

  return (
    <div className="animate-fade-in">
      <PageToolbar className="flex-col items-start gap-4 lg:flex-row lg:items-center">
        <div>
          <h1 className="text-sm font-medium text-foreground">Operations</h1>
          <p className="text-sm text-muted-foreground">
            Cost, latency, and cache metrics by operation name.
          </p>
        </div>
        <div className="flex-1" />
        <div className="flex rounded-lg border border-border bg-card">
          {TIME_RANGES.map((range) => (
            <button
              type="button"
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
      </PageToolbar>

      <div className="mb-6 flex flex-wrap items-center gap-2 rounded-xl bg-card/40 p-4">
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
          onChange={(value) => {
            setOperationFilter(value);
            setSelectedOperationName(value);
          }}
        />
        <FilterDropdown
          label="API Key"
          value={apiKeyFilter}
          options={apiKeyOptions}
          onChange={setApiKeyFilter}
          labelMap={apiKeyMap}
        />
        <div className="min-w-56 flex-1">
          <Input
            value={userIdFilter}
            onChange={(event) => setUserIdFilter(event.target.value)}
            placeholder="Filter by baggage.userId"
            aria-label="Filter by baggage.userId"
            className="bg-card text-sm"
          />
        </div>
        {hasActiveFilters && (
          <button
            type="button"
            onClick={clearFilters}
            className="rounded-lg border border-border px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            Clear filters
          </button>
        )}
      </div>

      {hasError && (
        <div className="mb-6 rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">
          Failed to load operations analytics. Please try refreshing.
        </div>
      )}

      {isInitialLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          Loading operations analytics...
        </div>
      ) : (
        <div className="space-y-6">
          {selectedOperation && (
            <div className="stagger-children grid grid-cols-2 gap-3 lg:grid-cols-4">
              <BarCard
                label="Cost"
                value={formatCurrency(selectedOperation.total_cost_usd)}
                accent="from-chart-4/20 to-chart-4/5"
                compact
                segments={[
                  {
                    key: 'input',
                    label: 'Input',
                    value: selectedOperation.input_cost_usd,
                    color: 'var(--color-chart-1)',
                  },
                  {
                    key: 'output',
                    label: 'Output',
                    value: selectedOperation.output_cost_usd,
                    color: 'var(--color-chart-2)',
                  },
                  {
                    key: 'cache_read',
                    label: 'Cache Read',
                    value: selectedOperation.cache_read_cost_usd,
                    color: 'var(--color-chart-3)',
                  },
                  {
                    key: 'cache_write',
                    label: 'Cache Write',
                    value: selectedOperation.cache_creation_cost_usd,
                    color: 'var(--color-chart-4)',
                  },
                  {
                    key: 'reasoning',
                    label: 'Reasoning',
                    value: selectedOperation.reasoning_cost_usd,
                    color: 'var(--color-chart-5)',
                  },
                ]}
                total={selectedOperation.total_cost_usd}
                formatter={formatCostCompact}
                inlineLabels={[
                  {
                    label: '/ request',
                    value: formatCurrency(getCostPerRequest(selectedOperation)),
                    color: 'var(--color-muted-foreground)',
                  },
                ]}
              />
              <BarCard
                label="Requests"
                value={formatNumber(selectedOperation.request_count)}
                accent="from-chart-5/20 to-chart-5/5"
                compact
                segments={[]}
                total={0}
                formatter={formatNumber}
                inlineLabels={[
                  {
                    label: 'tokens',
                    value: formatNumber(selectedOperation.total_tokens),
                    color: 'var(--color-muted-foreground)',
                  },
                ]}
              />
              <BarCard
                label="Cache Hit Rate"
                value={formatCacheHitRate(getAggregateCacheHitRate(selectedOperation))}
                accent="from-chart-3/20 to-chart-3/5"
                compact
                segments={
                  selectedOperation.input_tokens > 0
                    ? [
                        {
                          key: 'cached',
                          label: 'Cached',
                          value: selectedOperation.cache_read_input_tokens,
                          color: 'var(--color-chart-3)',
                        },
                        {
                          key: 'warmup',
                          label: 'Warmup',
                          value: selectedOperation.cache_creation_input_tokens,
                          color: 'var(--color-chart-4)',
                        },
                        {
                          key: 'uncached',
                          label: 'Uncached',
                          value: selectedOperation.uncached_input_tokens,
                          color: 'var(--color-muted-foreground)',
                        },
                      ]
                    : []
                }
                total={selectedOperation.input_tokens}
                formatter={formatNumber}
                showPercent
              />
              <BarCard
                label="Latency"
                value={formatDuration(selectedOperation.avg_duration_ms)}
                accent="from-chart-7/20 to-chart-7/5"
                compact
                segments={[]}
                total={0}
                formatter={formatDuration}
                inlineLabels={[
                  {
                    label: 'P95',
                    value: formatDuration(selectedOperation.p95_duration_ms),
                    color: 'var(--color-chart-6)',
                  },
                  {
                    label: 'Max',
                    value: formatDuration(selectedOperation.max_duration_ms),
                    color: 'var(--color-chart-1)',
                  },
                ]}
              />
            </div>
          )}

          <div className="rounded-xl bg-card/40 p-6">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Layers className="h-4 w-4 text-muted-foreground" />
                <div>
                  <h2 className="text-base font-medium text-foreground">Operations</h2>
                  <p className="text-xs text-muted-foreground">
                    Click a row to drill into user-level breakdown.
                  </p>
                </div>
              </div>
              <span className="rounded-md bg-muted/60 px-2 py-1 font-mono text-xs tabular-nums text-muted-foreground">
                {formatNumber(operations.length)} ops
              </span>
            </div>
            <OperationsLeaderboardTable
              data={sortedOperations}
              selectedOperation={activeOperation}
              onSelectOperation={setSelectedOperationName}
              sortKey={sortKey}
              sortDesc={sortDesc}
              onSort={handleSort}
            />
          </div>

          <div className="rounded-xl bg-card/40 p-6">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Users className="h-4 w-4 text-muted-foreground" />
                <div>
                  <h2 className="text-base font-medium text-foreground">User breakdown</h2>
                  {activeOperation ? (
                    <p className="text-xs text-muted-foreground">
                      Top users for{' '}
                      <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
                        {activeOperation}
                      </code>
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Select an operation above to see per-user metrics.
                    </p>
                  )}
                </div>
              </div>
            </div>
            {activeOperation ? (
              isUsersLoading ? (
                <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                  Loading user breakdown...
                </div>
              ) : (
                <OperationUsersTable data={users} />
              )
            ) : (
              <div className="flex flex-col items-center gap-2 py-12 text-center">
                <Database className="h-8 w-8 text-muted-foreground/30" />
                <p className="text-sm text-muted-foreground">
                  Choose an operation from the table above to inspect{' '}
                  <code className="rounded bg-muted px-1 py-0.5 text-xs">baggage.userId</code>{' '}
                  breakdowns.
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
