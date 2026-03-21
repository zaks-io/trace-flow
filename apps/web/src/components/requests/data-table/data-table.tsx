'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type VisibilityState,
} from '@tanstack/react-table';
import { cn } from '@/lib/utils';
import { TableToolbar, type AlertFilterValue } from './table-toolbar';
import type { TraceAlertSummary, Alert } from '@/types/alerts';
import type { TableFilters } from '@/hooks/useTableFilters';
import type { FilterOptions } from '@/hooks/useFilterOptions';

export type { AlertFilterValue };

const NEW_ROW_THRESHOLD_MS = 60_000;

function isNewRow(row: unknown): boolean {
  const data = row as { ReceivedAt?: number; LatestReceivedAt?: number };
  const timestamp = data.ReceivedAt ?? data.LatestReceivedAt;
  if (typeof timestamp !== 'number') return false;
  const receivedAt = new Date(timestamp / 1_000_000);
  const now = new Date();
  const ageMs = now.getTime() - receivedAt.getTime();
  return ageMs < NEW_ROW_THRESHOLD_MS;
}

function getReceivedAt(row: unknown): number | null {
  const data = row as { ReceivedAt?: number; LatestReceivedAt?: number };
  const timestamp = data.ReceivedAt ?? data.LatestReceivedAt;
  return typeof timestamp === 'number' ? timestamp : null;
}

interface DataTableProps<TData> {
  columns: ColumnDef<TData>[];
  data: TData[];
  columnVisibility: VisibilityState;
  onColumnVisibilityChange: (
    updater: VisibilityState | ((prev: VisibilityState) => VisibilityState),
  ) => void;
  onRowClick?: (row: TData, event: React.MouseEvent) => void;
  selectedRowId?: string | null;
  getRowId: (row: TData) => string;
  isLiveMode?: boolean;
  onLiveModeToggle?: () => void;
  alertSummary?: Map<string, TraceAlertSummary>;
  alerts?: Alert[];
  alertFilter?: AlertFilterValue;
  onAlertFilterChange?: (filter: AlertFilterValue) => void;
  filters?: TableFilters;
  filterOptions?: FilterOptions;
  filterOptionsLoading?: boolean;
  onFilterChange?: (key: keyof TableFilters, value: string | null) => void;
  onClearFilters?: () => void;
  hasActiveFilters?: boolean;
  loading?: boolean;
  emptyMessage?: React.ReactNode;
  apiKeyMap?: Map<string, string>;
  hideToolbar?: boolean;
  rowClassName?: (row: TData) => string | undefined;
}

export function DataTable<TData>({
  columns,
  data,
  columnVisibility,
  onColumnVisibilityChange,
  onRowClick,
  selectedRowId,
  getRowId,
  isLiveMode,
  onLiveModeToggle,
  alertSummary,
  alerts,
  alertFilter = 'all',
  onAlertFilterChange,
  filters,
  filterOptions,
  filterOptionsLoading,
  onFilterChange,
  onClearFilters,
  hasActiveFilters,
  loading,
  emptyMessage = 'No results found',
  apiKeyMap,
  hideToolbar,
  rowClassName,
}: DataTableProps<TData>) {
  const filteredData = useMemo(() => {
    if (!alertSummary || alertFilter === 'all') {
      return data;
    }

    return data.filter((row) => {
      const rowData = row as { TraceId?: string };
      const traceId = rowData.TraceId ?? '';
      const summary = alertSummary.get(traceId);

      if (alertFilter === 'has-alerts') {
        return summary && summary.triggeredAlerts.length > 0;
      }

      // Filter by specific alert ID
      if (summary) {
        return summary.triggeredAlerts.some((t) => t.alert._id === alertFilter);
      }
      return false;
    });
  }, [data, alertSummary, alertFilter]);

  // Force re-render when "new" rows age out
  const [, forceUpdate] = useState(0);
  useEffect(() => {
    const now = new Date();
    const newRowTimestamps = filteredData
      .map((row) => getReceivedAt(row))
      .filter((ts): ts is number => {
        if (ts === null) return false;
        const receivedAt = new Date(ts / 1_000_000);
        return now.getTime() - receivedAt.getTime() < NEW_ROW_THRESHOLD_MS;
      });

    if (newRowTimestamps.length === 0) return;

    // Find the oldest "new" row and set timer for when it ages out
    const oldestTimestamp = Math.min(...newRowTimestamps);
    const oldestReceivedAt = new Date(oldestTimestamp / 1_000_000);
    const ageMs = now.getTime() - oldestReceivedAt.getTime();
    const remainingMs = NEW_ROW_THRESHOLD_MS - ageMs + 100;

    if (remainingMs > 0) {
      const timer = setTimeout(() => forceUpdate((n) => n + 1), remainingMs);
      return () => clearTimeout(timer);
    }
  }, [filteredData]);

  const table = useReactTable({
    data: filteredData,
    columns,
    getCoreRowModel: getCoreRowModel(),
    state: {
      columnVisibility,
    },
    onColumnVisibilityChange: (updater) => {
      onColumnVisibilityChange(updater);
    },
    getRowId,
    meta: {
      alertSummary,
    },
  });

  return (
    <div className={hideToolbar ? '' : 'space-y-4'}>
      {!hideToolbar && (
        <TableToolbar
          table={table}
          filters={filters}
          filterOptions={filterOptions}
          filterOptionsLoading={filterOptionsLoading}
          onFilterChange={onFilterChange}
          onClearFilters={onClearFilters}
          hasActiveFilters={hasActiveFilters}
          alerts={alerts}
          alertFilter={alertFilter}
          onAlertFilterChange={onAlertFilterChange}
          isLiveMode={isLiveMode}
          onLiveModeToggle={onLiveModeToggle}
          apiKeyMap={apiKeyMap}
        />
      )}

      <div className="card-elevated overflow-hidden rounded-xl bg-card/40 relative">
        {/* Loading overlay */}
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-card/80 backdrop-blur-[1px]">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              Loading...
            </div>
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-border">
            <thead className="bg-muted/30">
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <th
                      key={header.id}
                      className={cn(
                        'px-6 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground',
                        header.id === 'trace' && 'py-3 pl-4 pr-6',
                      )}
                      style={
                        header.column.columnDef.size
                          ? { width: header.column.columnDef.size }
                          : undefined
                      }
                    >
                      {header.isPlaceholder
                        ? null
                        : flexRender(header.column.columnDef.header, header.getContext())}
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody className="divide-y divide-border/50 bg-transparent">
              {table.getRowModel().rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={table.getVisibleLeafColumns().length}
                    className="py-12 text-center text-muted-foreground"
                  >
                    {emptyMessage}
                  </td>
                </tr>
              ) : (
                table.getRowModel().rows.map((row) => (
                  <tr
                    key={row.id}
                    className={cn(
                      'table-row-interactive cursor-pointer',
                      selectedRowId === row.id && 'bg-primary/5',
                      isNewRow(row.original) && 'table-row-new',
                      rowClassName?.(row.original),
                    )}
                    onClick={(e) => onRowClick?.(row.original, e)}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <td
                        key={cell.id}
                        className={cn(
                          'whitespace-nowrap px-6 py-4 text-sm text-foreground',
                          cell.column.id === 'trace' && 'whitespace-normal py-3 pl-4 pr-6',
                        )}
                        style={
                          cell.column.columnDef.size
                            ? { width: cell.column.columnDef.size }
                            : undefined
                        }
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="border-t border-border bg-muted/20 px-6 py-3">
          <p className="text-xs text-muted-foreground">
            Showing {table.getRowModel().rows.length}{' '}
            {table.getRowModel().rows.length === 1 ? 'request' : 'requests'}
          </p>
        </div>
      </div>
    </div>
  );
}
