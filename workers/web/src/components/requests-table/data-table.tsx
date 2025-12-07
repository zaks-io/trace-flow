'use client';

import { useMemo } from 'react';
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type VisibilityState,
} from '@tanstack/react-table';
import { Filter, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ColumnToggle } from './column-toggle';
import type { TraceAlertSummary, Alert } from '@/types/alerts';

export type AlertFilterValue = string;

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
  }, [data, alertSummary, alertFilter, getRowId]);

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
    <div className="space-y-4">
      <div className="flex items-center justify-end gap-2">
        {onAlertFilterChange && alerts && alerts.length > 0 && (
          <div className="relative">
            <select
              value={alertFilter}
              onChange={(e) => onAlertFilterChange(e.target.value)}
              className={cn(
                'appearance-none rounded-lg border bg-card pl-9 pr-8 py-2 text-sm font-medium transition-colors',
                'focus:outline-none focus:ring-2 focus:ring-primary/20',
                alertFilter !== 'all'
                  ? 'border-primary/50 text-primary'
                  : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <option value="all">All Requests</option>
              <option value="has-alerts">Has Alerts</option>
              {alerts.map((alert) => (
                <option key={alert._id} value={alert._id}>
                  {alert.name}
                </option>
              ))}
            </select>
            <Filter className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          </div>
        )}
        <ColumnToggle table={table} />
        {onLiveModeToggle && (
          <button
            onClick={onLiveModeToggle}
            className={cn(
              'flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-all',
              isLiveMode
                ? 'border-destructive/50 bg-destructive/10 text-destructive hover:bg-destructive/20'
                : 'border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            <div className="flex items-center gap-2">
              {isLiveMode && (
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive opacity-75"></span>
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-destructive"></span>
                </span>
              )}
              <span>{isLiveMode ? 'LIVE' : 'Live Mode'}</span>
            </div>
          </button>
        )}
      </div>

      <div className="card-elevated overflow-hidden rounded-xl border border-border bg-card">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-border">
            <thead className="bg-muted/30">
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <th
                      key={header.id}
                      className="px-6 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground"
                    >
                      {header.isPlaceholder
                        ? null
                        : flexRender(header.column.columnDef.header, header.getContext())}
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody className="divide-y divide-border bg-card">
              {table.getRowModel().rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={table.getVisibleLeafColumns().length}
                    className="py-12 text-center text-muted-foreground"
                  >
                    No requests found
                  </td>
                </tr>
              ) : (
                table.getRowModel().rows.map((row) => (
                  <tr
                    key={row.id}
                    className={cn(
                      'table-row-interactive cursor-pointer',
                      selectedRowId === row.id && 'bg-primary/5',
                    )}
                    onClick={(e) => onRowClick?.(row.original, e)}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <td
                        key={cell.id}
                        className="whitespace-nowrap px-6 py-4 text-sm text-foreground"
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
