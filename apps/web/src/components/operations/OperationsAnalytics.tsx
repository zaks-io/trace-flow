'use client';

import { useMemo } from 'react';
import { type Preloaded, usePreloadedQuery } from 'convex/react';
import { type api } from '@trace-flow/convex/_generated/api';
import { Layers } from 'lucide-react';
import { useApiKeyMap } from '@/hooks/useApiKeyMap';
import { PageToolbar } from '@/components/shared/PageToolbar';
import { FilterDropdown } from '@/components/usage/FilterDropdown';
import { TIME_RANGES } from '@/components/usage/types';
import { Input } from '@/components/ui/input';
import { formatNumber } from '@/lib/format';
import { sortFilterOptions } from '@/lib/sortFilterOptions';
import { useOperationsFilters } from './useOperationsFilters';
import { useOperationsData } from './useOperationsData';
import { LeaderboardTable } from './LeaderboardTable';
import { OperationDetailPanel } from './OperationDetailPanel';

export function OperationsAnalytics({
  preloadedApiKeys,
}: {
  preloadedApiKeys: Preloaded<typeof api.apiKeys.listAnalytics>;
}) {
  const apiKeys = usePreloadedQuery(preloadedApiKeys);
  const apiKeyMap = useApiKeyMap(apiKeys);

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
  } = useOperationsFilters();

  const {
    operations,
    sortedOperations,
    users,
    providers,
    models,
    selectedOperation,
    isInitialLoading,
    isUsersLoading,
    hasError,
  } = useOperationsData({ filterParams, activeOperation, sortKey, sortDesc });

  const providerOptions = useMemo(() => {
    const values = providers.map((p) => p.provider);
    if (providerFilter) values.push(providerFilter);
    return sortFilterOptions(values);
  }, [providers, providerFilter]);

  const modelOptions = useMemo(() => {
    const values = models.map((m) => m.model);
    if (modelFilter) values.push(modelFilter);
    return sortFilterOptions(values);
  }, [models, modelFilter]);

  const operationOptions = useMemo(() => {
    const values = operations.map((o) => o.operation);
    if (operationFilter) values.push(operationFilter);
    return sortFilterOptions(values);
  }, [operations, operationFilter]);

  const apiKeyOptions = useMemo(
    () => sortFilterOptions(Array.from(apiKeyMap.keys()), apiKeyMap),
    [apiKeyMap],
  );

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
        <div className="rounded-xl bg-card/40 p-6">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Layers className="h-4 w-4 text-muted-foreground" />
              <div>
                <h2 className="text-base font-medium text-foreground">Operations</h2>
                <p className="text-xs text-muted-foreground">
                  Click a row to view per-user breakdown.
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
      )}

      <OperationDetailPanel
        operation={selectedOperation}
        operationName={activeOperation}
        users={users}
        isUsersLoading={isUsersLoading}
        isOpen={!!activeOperation}
        onClose={() => setSelectedOperationName('')}
      />
    </div>
  );
}
