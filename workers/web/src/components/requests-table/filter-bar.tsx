import { useState, useEffect, useCallback } from 'react';
import { Search, ChevronDown, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TableFilters } from '@/hooks/useTableFilters';
import type { FilterOptions } from '@/hooks/useFilterOptions';

interface FilterBarProps {
  filters: TableFilters;
  options: FilterOptions;
  optionsLoading: boolean;
  onFilterChange: (key: keyof TableFilters, value: string | null) => void;
  onClearFilters: () => void;
  hasActiveFilters: boolean;
}

interface FilterSelectProps {
  label: string;
  value: string | null;
  options: string[];
  loading: boolean;
  onChange: (value: string | null) => void;
}

function FilterSelect({ label, value, options, loading, onChange }: FilterSelectProps) {
  const hasValue = value !== null;

  return (
    <div className="relative">
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        disabled={loading}
        className={cn(
          'appearance-none rounded-lg border bg-card pl-3 pr-8 py-2 text-sm font-medium transition-colors min-w-[140px]',
          'focus:outline-none focus:ring-2 focus:ring-primary/20',
          'disabled:opacity-50 disabled:cursor-not-allowed',
          hasValue
            ? 'border-primary/50 text-primary'
            : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground',
        )}
      >
        <option value="">{loading ? 'Loading...' : `All ${label}s`}</option>
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}

export function FilterBar({
  filters,
  options,
  optionsLoading,
  onFilterChange,
  onClearFilters,
  hasActiveFilters,
}: FilterBarProps) {
  const [searchValue, setSearchValue] = useState(filters.search ?? '');

  // Sync local search state with external filter state
  useEffect(() => {
    setSearchValue(filters.search ?? '');
  }, [filters.search]);

  // Debounced search handler
  useEffect(() => {
    const timeout = setTimeout(() => {
      const trimmed = searchValue.trim();
      if (trimmed !== (filters.search ?? '')) {
        onFilterChange('search', trimmed.length > 0 ? trimmed : null);
      }
    }, 300);

    return () => clearTimeout(timeout);
  }, [searchValue, filters.search, onFilterChange]);

  const handleSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchValue(e.target.value);
  }, []);

  const handleClearSearch = useCallback(() => {
    setSearchValue('');
    onFilterChange('search', null);
  }, [onFilterChange]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Search Input */}
      <div className="relative flex-1 min-w-[200px] max-w-[300px]">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          type="text"
          placeholder="Search traces..."
          value={searchValue}
          onChange={handleSearchChange}
          className={cn(
            'w-full rounded-lg border bg-card pl-9 pr-9 py-2 text-sm transition-colors',
            'placeholder:text-muted-foreground',
            'focus:outline-none focus:ring-2 focus:ring-primary/20',
            searchValue ? 'border-primary/50' : 'border-border hover:bg-muted hover:border-border',
          )}
        />
        {searchValue && (
          <button
            onClick={handleClearSearch}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      {/* Provider Filter */}
      <FilterSelect
        label="Provider"
        value={filters.provider}
        options={options.providers}
        loading={optionsLoading}
        onChange={(value) => onFilterChange('provider', value)}
      />

      {/* Model Filter */}
      <FilterSelect
        label="Model"
        value={filters.model}
        options={options.models}
        loading={optionsLoading}
        onChange={(value) => onFilterChange('model', value)}
      />

      {/* Status Filter */}
      <FilterSelect
        label="Status"
        value={filters.status}
        options={options.statuses}
        loading={optionsLoading}
        onChange={(value) => onFilterChange('status', value)}
      />

      {/* Clear Filters Button */}
      {hasActiveFilters && (
        <button
          onClick={onClearFilters}
          className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
          Clear
        </button>
      )}
    </div>
  );
}
