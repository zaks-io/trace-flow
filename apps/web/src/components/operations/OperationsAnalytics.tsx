'use client';

import { useMemo } from 'react';
import { type Preloaded, usePreloadedQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import { Database, Layers, Users } from 'lucide-react';
import { useApiKeyMap } from '@/hooks/useApiKeyMap';
import { PageToolbar } from '@/components/shared/PageToolbar';
import { FilterDropdown } from '@/components/usage/FilterDropdown';
import { TIME_RANGES } from '@/components/usage/types';
import { Input } from '@/components/ui/input';
import { formatNumber } from '@/lib/format';
import { useOperationsFilters } from './useOperationsFilters';
import { useOperationsData } from './useOperationsData';
import { SummaryCards } from './SummaryCards';
import { LeaderboardTable } from './LeaderboardTable';
import { UsersTable } from './UsersTable';

export function OperationsAnalytics({
  preloadedApiKeys,
}: {
  preloadedApiKeys: Preloaded<typeof api.apiKeys.list>;
}) {
  const apiKeys = usePreloadedQuery(preloadedApiKeys);
  const apiKeyMap = useApiKeyMap(apiKeys);

  const filters = useOperationsFilters();
  const {
    timeRange,
    setTimeRange,
    providerFilter,
    setProviderFilter,
    modelFilter,
    setModelFilter,
    operationFilter,
    setOperationFilter,
    setSelectedOperationName,
    apiKeyFilter,
    setApiKeyFilter,
    userIdFilter,
    setUserIdFilter,
    sortKey,
    setSortKey,
    sortDesc,
    setSortDesc,
    filterParams,
    activeOperation,
    hasActiveFilters,
    clearFilters,
    seenProviders,
    seenModels,
    seenOperations,
  } = filters;

  const {
    operations,
    sortedOperations,
    users,
    filterOptions,
    selectedOperation,
    isInitialLoading,
    isUsersLoading,
    hasError,
  } = useOperationsData({ filterParams, activeOperation, sortKey, sortDesc });

  // Accumulate filter options across queries so dropdowns don't collapse when a filter is applied
  filterOptions?.providers.forEach((p) => seenProviders.current.add(p));
  filterOptions?.models.forEach((m) => seenModels.current.add(m));
  filterOptions?.operations.forEach((o) => seenOperations.current.add(o));
  operations.forEach((row) => seenOperations.current.add(row.operation));

  if (providerFilter) seenProviders.current.add(providerFilter);
  if (modelFilter) seenModels.current.add(modelFilter);
  if (operationFilter) seenOperations.current.add(operationFilter);

  const providerOptions = Array.from(seenProviders.current);
  const modelOptions = Array.from(seenModels.current);
  const operationOptions = Array.from(seenOperations.current);
  const apiKeyOptions = useMemo(() => apiKeys.map((k) => k.key), [apiKeys]);

  function handleSort(key: typeof sortKey) {
    if (sortKey === key) {
      setSortDesc((d) => !d);
    } else {
      setSortKey(key);
      setSortDesc(true);
    }
  }

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
            placeholder="Filter by baggage.user_id"
            aria-label="Filter by baggage.user_id"
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
          {selectedOperation && <SummaryCards operation={selectedOperation} />}

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
            <LeaderboardTable
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
                <UsersTable data={users} />
              )
            ) : (
              <div className="flex flex-col items-center gap-2 py-12 text-center">
                <Database className="h-8 w-8 text-muted-foreground/30" />
                <p className="text-sm text-muted-foreground">
                  Choose an operation from the table above to inspect{' '}
                  <code className="rounded bg-muted px-1 py-0.5 text-xs">baggage.user_id</code>{' '}
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
