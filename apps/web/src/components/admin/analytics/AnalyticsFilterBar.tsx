import type { Dispatch, SetStateAction } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FilterDropdown } from '@/components/usage/FilterDropdown';
import { cn } from '@/lib/utils';
import { TIME_RANGES } from './constants';
import type { DashboardData, FiltersState, TimeRangeValue } from './types';

export function AnalyticsFilterBar({
  timeRange,
  setTimeRange,
  filters,
  setFilters,
  filterOptions,
}: {
  timeRange: TimeRangeValue;
  setTimeRange: (value: TimeRangeValue) => void;
  filters: FiltersState;
  setFilters: Dispatch<SetStateAction<FiltersState>>;
  filterOptions: DashboardData['filterOptions'] | undefined;
}) {
  const hasActiveFilters = Object.values(filters).some(Boolean);

  return (
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
        options={filterOptions?.providers ?? []}
        onChange={(value) => setFilters((current) => ({ ...current, provider: value }))}
      />
      <FilterDropdown
        label="Status"
        value={filters.statusCode}
        options={filterOptions?.statusCodes ?? []}
        onChange={(value) => setFilters((current) => ({ ...current, statusCode: value }))}
      />
      <FilterDropdown
        label="Operation"
        value={filters.operation}
        options={filterOptions?.operations ?? []}
        onChange={(value) => setFilters((current) => ({ ...current, operation: value }))}
      />
      <FilterDropdown
        label="Model"
        value={filters.model}
        options={filterOptions?.models ?? []}
        onChange={(value) => setFilters((current) => ({ ...current, model: value }))}
      />
      <FilterDropdown
        label="Skip"
        value={filters.skipReason}
        options={filterOptions?.skipReasons ?? []}
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
  );
}
