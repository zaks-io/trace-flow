import type { VisibilityState } from '@tanstack/react-table';
import { ArrowDownToLine, ChevronLeft, ChevronRight, Loader2, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import {
  BOOLEAN_COLUMNS,
  explorerColumns,
  NUMERIC_EXPLORER_COLUMNS,
  type ExplorerColumn,
} from './constants';
import { formatBooleanCell, formatCellValue, formatInteger } from './format';
import { LoadingState } from './LoadingState';
import { SectionError } from './SectionError';
import type { ExplorerResponse, ExplorerRow } from './types';

export function ExplorerPanel({
  isLoading,
  error,
  data,
  rows,
  visibleColumns,
  visibility,
  setVisibility,
  search,
  setSearch,
  offset,
  setOffset,
  onSelectRow,
  exportPending,
  exportError,
  onExport,
}: {
  isLoading: boolean;
  error: string;
  data: ExplorerResponse | undefined;
  rows: ExplorerRow[];
  visibleColumns: ExplorerColumn[];
  visibility: VisibilityState;
  setVisibility: (updater: (prev: VisibilityState) => VisibilityState) => void;
  search: string;
  setSearch: (value: string) => void;
  offset: number;
  setOffset: (updater: (current: number) => number) => void;
  onSelectRow: (row: ExplorerRow) => void;
  exportPending: boolean;
  exportError: string;
  onExport: () => void;
}) {
  return (
    <Card className="bg-card/40">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle>Raw Event Explorer</CardTitle>
            <CardDescription>
              Page through sampled Analytics Engine rows, inspect fields, and export filtered
              results.
            </CardDescription>
          </div>
          <Button variant="outline" onClick={() => onExport()} disabled={exportPending}>
            {exportPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ArrowDownToLine className="h-4 w-4" />
            )}
            Export CSV
          </Button>
        </div>
        {exportError && <SectionError message={exportError} />}
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-3">
          <div className="relative max-w-sm">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search the current explorer page"
              className="pl-9"
            />
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {explorerColumns.map((column) => (
              <button
                key={column}
                onClick={() =>
                  setVisibility((current) => ({
                    ...current,
                    [column]: !current[column],
                  }))
                }
                className={cn(
                  'rounded-full border px-2 py-0.5 text-[11px] transition-colors',
                  visibility[column]
                    ? 'border-primary/30 bg-primary/10 text-primary'
                    : 'border-transparent bg-muted/40 text-muted-foreground hover:border-border',
                )}
              >
                {column}
              </button>
            ))}
          </div>
        </div>

        {isLoading ? (
          <LoadingState label="Loading explorer rows..." />
        ) : error ? (
          <SectionError message={error} />
        ) : (
          <>
            <div className="overflow-hidden rounded-xl border border-border">
              <div className="border-b border-border bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
                Current SQL
              </div>
              <pre className="tabular-mono overflow-x-auto bg-background/60 p-4 text-[11px] text-muted-foreground">
                {data?.sql}
              </pre>
            </div>
            <div className="overflow-hidden rounded-xl border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    {visibleColumns.map((column) => (
                      <TableHead key={column}>{column}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={visibleColumns.length}
                        className="py-8 text-center text-muted-foreground"
                      >
                        No explorer rows match the current page or search.
                      </TableCell>
                    </TableRow>
                  ) : (
                    rows.map((row, index) => (
                      <TableRow
                        key={`${index}-${row.timestamp}-${row.orgId}-${row.model}-${row.totalLatencyMs}`}
                        className="table-row-interactive cursor-pointer"
                        onClick={() => onSelectRow(row)}
                      >
                        {visibleColumns.map((column) => (
                          <TableCell
                            key={column}
                            className={NUMERIC_EXPLORER_COLUMNS.has(column) ? 'tabular-mono' : ''}
                          >
                            {typeof row[column] === 'number'
                              ? formatInteger(Number(row[column]))
                              : BOOLEAN_COLUMNS.has(column)
                                ? formatBooleanCell(String(row[column]))
                                : formatCellValue(String(row[column]))}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
            <div className="flex items-center justify-between gap-3">
              <p className="tabular-mono text-[11px] text-muted-foreground">
                Offset {data?.offset ?? 0} &bull; Page size {data?.limit ?? 100}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  disabled={offset === 0}
                  onClick={() => setOffset((current) => Math.max(0, current - 100))}
                >
                  <ChevronLeft className="h-4 w-4" />
                  Previous
                </Button>
                <Button
                  variant="outline"
                  disabled={!data?.hasMore}
                  onClick={() => setOffset((current) => current + 100)}
                >
                  Next
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
