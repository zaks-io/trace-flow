'use client';

import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type VisibilityState,
} from '@tanstack/react-table';
import { cn } from '@/lib/utils';
import { ColumnToggle } from './column-toggle';

interface DataTableProps<TData> {
  columns: ColumnDef<TData>[];
  data: TData[];
  columnVisibility: VisibilityState;
  onColumnVisibilityChange: (
    updater: VisibilityState | ((prev: VisibilityState) => VisibilityState),
  ) => void;
  onRowClick?: (row: TData, event: React.MouseEvent) => void;
  getRowId: (row: TData) => string;
}

export function DataTable<TData>({
  columns,
  data,
  columnVisibility,
  onColumnVisibilityChange,
  onRowClick,
  getRowId,
}: DataTableProps<TData>) {
  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    state: {
      columnVisibility,
    },
    onColumnVisibilityChange: (updater) => {
      onColumnVisibilityChange(updater);
    },
    getRowId,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <ColumnToggle table={table} />
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
                    No traces found
                  </td>
                </tr>
              ) : (
                table.getRowModel().rows.map((row) => (
                  <tr
                    key={row.id}
                    className={cn('table-row-interactive', onRowClick && 'cursor-pointer')}
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
            {table.getRowModel().rows.length === 1 ? 'trace' : 'traces'}
          </p>
        </div>
      </div>
    </div>
  );
}
