'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Search, ChevronDown, X, Filter, Settings2 } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { sortFilterOptions } from '@/lib/sortFilterOptions';
import type { TableFilters } from '@/hooks/useTableFilters';
import type { FilterOptions } from '@/hooks/useFilterOptions';
import type { Alert } from '@/types/alerts';
import type { Table, ColumnDef, VisibilityState } from '@tanstack/react-table';
import { readTraceColumnMeta } from './metadata';

export type AlertFilterValue = string;

interface FilterDropdownProps {
  label: string;
  value: string | null;
  options: string[];
  loading?: boolean;
  onChange: (value: string | null) => void;
  icon?: React.ReactNode;
  labelMap?: Map<string, string>;
}

function FilterDropdown({
  label,
  value,
  options,
  loading,
  onChange,
  icon,
  labelMap,
}: FilterDropdownProps) {
  const hasValue = value !== null;
  const displayValue = hasValue ? (labelMap?.get(value) ?? value) : `${label}`;
  const sortedOptions = useMemo(() => sortFilterOptions(options, labelMap), [options, labelMap]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={loading}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition-all',
          'hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/20',
          'disabled:opacity-50 disabled:cursor-not-allowed',
          hasValue
            ? 'bg-primary/10 text-primary border border-primary/30'
            : 'text-muted-foreground hover:text-foreground',
        )}
      >
        {icon}
        <span className="max-w-[120px] truncate">{loading ? 'Loading...' : displayValue}</span>
        <ChevronDown className="h-3.5 w-3.5 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[160px]">
        <DropdownMenuItem onClick={() => onChange(null)} className={cn(!hasValue && 'bg-muted')}>
          All {label}s
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {sortedOptions.map((opt) => (
          <DropdownMenuItem
            key={opt}
            onClick={() => onChange(opt)}
            className={cn(value === opt && 'bg-muted')}
          >
            {labelMap?.get(opt) ?? opt}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface AlertFilterDropdownProps {
  value: AlertFilterValue;
  alerts: Alert[];
  onChange: (value: AlertFilterValue) => void;
}

function AlertFilterDropdown({ value, alerts, onChange }: AlertFilterDropdownProps) {
  const sortedAlerts = useMemo(
    () => [...alerts].sort((a, b) => a.name.localeCompare(b.name)),
    [alerts],
  );
  const hasValue = value !== 'all';
  const displayValue =
    value === 'all'
      ? 'Alerts'
      : value === 'has-alerts'
        ? 'Has Alerts'
        : (alerts.find((a) => a._id === value)?.name ?? 'Alerts');

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition-all',
          'hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/20',
          hasValue
            ? 'bg-primary/10 text-primary border border-primary/30'
            : 'text-muted-foreground hover:text-foreground',
        )}
      >
        <Filter className="h-3.5 w-3.5" />
        <span className="max-w-[100px] truncate">{displayValue}</span>
        <ChevronDown className="h-3.5 w-3.5 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[160px]">
        <DropdownMenuItem
          onClick={() => onChange('all')}
          className={cn(value === 'all' && 'bg-muted')}
        >
          All Requests
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => onChange('has-alerts')}
          className={cn(value === 'has-alerts' && 'bg-muted')}
        >
          Has Alerts
        </DropdownMenuItem>
        {sortedAlerts.length > 0 && <DropdownMenuSeparator />}
        {sortedAlerts.map((alert) => (
          <DropdownMenuItem
            key={alert._id}
            onClick={() => onChange(alert._id)}
            className={cn(value === alert._id && 'bg-muted')}
          >
            {alert.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const categoryLabels: Record<string, string> = {
  standard: 'Standard',
  ai: 'AI',
  http: 'HTTP',
};

const categoryOrder = ['standard', 'ai', 'http'];

interface ColumnToggleWithTableProps<TData> {
  table: Table<TData>;
  columnDefs?: never;
  columnVisibility?: never;
  onColumnVisibilityChange?: never;
}

interface ColumnToggleStandaloneProps {
  table?: never;
  columnDefs: ColumnDef<unknown>[];
  columnVisibility: VisibilityState;
  onColumnVisibilityChange: (
    updater: VisibilityState | ((prev: VisibilityState) => VisibilityState),
  ) => void;
}

type ColumnToggleProps<TData> = ColumnToggleWithTableProps<TData> | ColumnToggleStandaloneProps;

function ColumnToggleDropdown<TData>(props: ColumnToggleProps<TData>) {
  let items: {
    id: string;
    label: string;
    category: string;
    canHide: boolean;
    isVisible: boolean;
    toggle: (v: boolean) => void;
  }[];

  if (props.table) {
    const columns = props.table.getAllLeafColumns();
    items = columns.map((col) => {
      const meta = readTraceColumnMeta(col.columnDef.meta);
      return {
        id: col.id,
        label: meta?.label ?? col.id,
        category: meta?.category ?? 'standard',
        canHide: col.getCanHide(),
        isVisible: col.getIsVisible(),
        toggle: (v: boolean) => col.toggleVisibility(v),
      };
    });
  } else {
    const { columnDefs, columnVisibility, onColumnVisibilityChange } = props;
    items = columnDefs
      .filter((col): col is ColumnDef<unknown> & { id: string } => !!col.id)
      .map((col) => {
        const meta = readTraceColumnMeta(col.meta);
        const id = col.id!;
        return {
          id,
          label: meta?.label ?? id,
          category: meta?.category ?? 'standard',
          canHide: col.enableHiding !== false,
          isVisible: columnVisibility[id] !== false,
          toggle: (v: boolean) => onColumnVisibilityChange((prev) => ({ ...prev, [id]: v })),
        };
      });
  }

  const grouped = items
    .filter((item) => item.canHide)
    .reduce(
      (acc, item) => {
        acc[item.category] ??= [];
        acc[item.category].push(item);
        return acc;
      },
      {} as Record<string, typeof items>,
    );

  const sortedCategories = categoryOrder.filter((cat) => (grouped[cat]?.length ?? 0) > 0);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition-all',
          'text-muted-foreground hover:text-foreground hover:bg-muted',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/20',
        )}
      >
        <Settings2 className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">Columns</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {sortedCategories.map((category, index) => {
          const cols = grouped[category] ?? [];
          return (
            <div key={category}>
              {index > 0 && <DropdownMenuSeparator />}
              <DropdownMenuLabel>{categoryLabels[category] ?? category}</DropdownMenuLabel>
              {cols.map((item) => (
                <DropdownMenuCheckboxItem
                  key={item.id}
                  checked={item.isVisible}
                  onCheckedChange={(checked) => item.toggle(!!checked)}
                >
                  {item.label}
                </DropdownMenuCheckboxItem>
              ))}
            </div>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface TableToolbarProps<TData> {
  table?: Table<TData>;
  columnDefs?: ColumnDef<unknown>[];
  columnVisibility?: VisibilityState;
  onColumnVisibilityChange?: (
    updater: VisibilityState | ((prev: VisibilityState) => VisibilityState),
  ) => void;
  filters?: TableFilters;
  filterOptions?: FilterOptions;
  filterOptionsLoading?: boolean;
  onFilterChange?: (key: keyof TableFilters, value: string | null) => void;
  onClearFilters?: () => void;
  hasActiveFilters?: boolean;
  alerts?: Alert[];
  alertFilter?: AlertFilterValue;
  onAlertFilterChange?: (filter: AlertFilterValue) => void;
  isLiveMode?: boolean;
  onLiveModeToggle?: () => void;
  apiKeyOptions?: string[];
  apiKeyMap?: Map<string, string>;
}

export function TableToolbar<TData>({
  table,
  columnDefs,
  columnVisibility,
  onColumnVisibilityChange,
  filters,
  filterOptions,
  filterOptionsLoading,
  onFilterChange,
  onClearFilters,
  hasActiveFilters,
  alerts,
  alertFilter = 'all',
  onAlertFilterChange,
  isLiveMode,
  onLiveModeToggle,
  apiKeyOptions,
  apiKeyMap,
}: TableToolbarProps<TData>) {
  const [searchValue, setSearchValue] = useState(filters?.search ?? '');

  useEffect(() => {
    setSearchValue(filters?.search ?? '');
  }, [filters?.search]);

  useEffect(() => {
    if (!onFilterChange) return;
    const timeout = setTimeout(() => {
      const trimmed = searchValue.trim();
      if (trimmed !== (filters?.search ?? '')) {
        onFilterChange('search', trimmed.length > 0 ? trimmed : null);
      }
    }, 300);

    return () => clearTimeout(timeout);
  }, [searchValue, filters?.search, onFilterChange]);

  const handleSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchValue(e.target.value);
  }, []);

  const handleClearSearch = useCallback(() => {
    setSearchValue('');
    onFilterChange?.('search', null);
  }, [onFilterChange]);

  const showFilters = onFilterChange && filters && filterOptions;
  const showAlertFilter = onAlertFilterChange && alerts && alerts.length > 0;

  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-3 py-2">
      {/* Search Section */}
      {showFilters && (
        <div className="relative w-full max-w-[280px]">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search traces..."
            value={searchValue}
            onChange={handleSearchChange}
            className={cn(
              'w-full rounded-md border-0 bg-muted/50 pl-8 pr-8 py-1.5 text-sm transition-colors',
              'placeholder:text-muted-foreground/70',
              'focus:outline-none focus:bg-muted focus:ring-2 focus:ring-primary/20',
              searchValue && 'ring-1 ring-primary/30',
            )}
          />
          {searchValue && (
            <button
              onClick={handleClearSearch}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-background text-muted-foreground hover:text-foreground transition-colors"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      )}

      {/* Divider */}
      {showFilters && <div className="h-5 w-px bg-border/60" />}

      {/* Filters Section */}
      <div className="flex items-center gap-1">
        {showFilters && (
          <>
            <FilterDropdown
              label="Provider"
              value={filters.provider}
              options={filterOptions.providers}
              loading={filterOptionsLoading}
              onChange={(value) => onFilterChange('provider', value)}
            />
            <FilterDropdown
              label="Model"
              value={filters.model}
              options={filterOptions.models}
              loading={filterOptionsLoading}
              onChange={(value) => onFilterChange('model', value)}
            />
            <FilterDropdown
              label="Status"
              value={filters.status}
              options={filterOptions.statuses}
              loading={filterOptionsLoading}
              onChange={(value) => onFilterChange('status', value)}
            />
            {filterOptions.operations.length > 0 && (
              <FilterDropdown
                label="Operation"
                value={filters.operation}
                options={filterOptions.operations}
                loading={filterOptionsLoading}
                onChange={(value) => onFilterChange('operation', value)}
              />
            )}
            <FilterDropdown
              label="API Key"
              value={filters.apiKey}
              options={apiKeyOptions ?? []}
              onChange={(value) => onFilterChange('apiKey', value)}
              labelMap={apiKeyMap}
            />
          </>
        )}
        {showAlertFilter && (
          <AlertFilterDropdown value={alertFilter} alerts={alerts} onChange={onAlertFilterChange} />
        )}
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Divider */}
      <div className="h-5 w-px bg-border/60" />

      {/* Actions Section */}
      <div className="flex items-center gap-1">
        {hasActiveFilters && onClearFilters && (
          <button
            onClick={onClearFilters}
            className={cn(
              'inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-sm font-medium transition-all',
              'text-muted-foreground hover:text-foreground hover:bg-muted',
            )}
          >
            <X className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Clear</span>
          </button>
        )}

        {table ? (
          <ColumnToggleDropdown table={table} />
        ) : columnDefs && columnVisibility && onColumnVisibilityChange ? (
          <ColumnToggleDropdown
            columnDefs={columnDefs}
            columnVisibility={columnVisibility}
            onColumnVisibilityChange={onColumnVisibilityChange}
          />
        ) : null}

        {onLiveModeToggle && (
          <button
            onClick={onLiveModeToggle}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition-all',
              isLiveMode
                ? 'bg-destructive/10 text-destructive border border-destructive/30'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted',
            )}
          >
            {isLiveMode && (
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-destructive" />
              </span>
            )}
            <span>{isLiveMode ? 'LIVE' : 'Live'}</span>
          </button>
        )}
      </div>
    </div>
  );
}
