import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
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
import { EMPTY_VALUE } from './constants';
import {
  formatCellValue,
  formatCompactNumber,
  formatDuration,
  formatInteger,
  formatPercentage,
} from './format';
import type { BreakdownRow } from './types';

export function BreakdownTable({
  rows,
  search,
  onSearchChange,
}: {
  rows: BreakdownRow[];
  search: string;
  onSearchChange: (value: string) => void;
}) {
  const [sortKey, setSortKey] = useState<keyof BreakdownRow>('requestCount');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');

  const filteredRows = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    const nextRows = normalizedSearch
      ? rows.filter((row) =>
          formatCellValue(row.dimension).toLowerCase().includes(normalizedSearch),
        )
      : rows;

    return [...nextRows].sort((a, b) => {
      const left = a[sortKey];
      const right = b[sortKey];
      const direction = sortDirection === 'asc' ? 1 : -1;
      if (typeof left === 'string' && typeof right === 'string') {
        return left.localeCompare(right) * direction;
      }
      return (Number(left) - Number(right)) * direction;
    });
  }, [rows, search, sortKey, sortDirection]);

  const handleSort = (key: keyof BreakdownRow) => {
    if (sortKey === key) {
      setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setSortKey(key);
    setSortDirection(key === 'dimension' ? 'asc' : 'desc');
  };

  const sortIndicator = (key: keyof BreakdownRow) => {
    if (sortKey !== key) return null;
    return (
      <span className="ml-1 text-primary">{sortDirection === 'asc' ? '\u2191' : '\u2193'}</span>
    );
  };

  return (
    <Card className="bg-card/40">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle>Breakdown Table</CardTitle>
            <CardDescription>Search and sort any grouped dimension.</CardDescription>
          </div>
          <div className="relative w-full max-w-xs">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="Search current dimension"
              className="pl-9"
            />
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>
                <button
                  onClick={() => handleSort('dimension')}
                  className="text-[11px] uppercase tracking-wider font-medium text-muted-foreground hover:text-foreground"
                >
                  Dimension{sortIndicator('dimension')}
                </button>
              </TableHead>
              <TableHead>
                <button
                  onClick={() => handleSort('requestCount')}
                  className="text-[11px] uppercase tracking-wider font-medium text-muted-foreground hover:text-foreground"
                >
                  Requests{sortIndicator('requestCount')}
                </button>
              </TableHead>
              <TableHead>
                <button
                  onClick={() => handleSort('serverErrorRate')}
                  className="text-[11px] uppercase tracking-wider font-medium text-muted-foreground hover:text-foreground"
                >
                  Server Errors{sortIndicator('serverErrorRate')}
                </button>
              </TableHead>
              <TableHead>
                <button
                  onClick={() => handleSort('skipRate')}
                  className="text-[11px] uppercase tracking-wider font-medium text-muted-foreground hover:text-foreground"
                >
                  Skip Rate{sortIndicator('skipRate')}
                </button>
              </TableHead>
              <TableHead>
                <button
                  onClick={() => handleSort('p95LatencyMs')}
                  className="text-[11px] uppercase tracking-wider font-medium text-muted-foreground hover:text-foreground"
                >
                  P95 Latency{sortIndicator('p95LatencyMs')}
                </button>
              </TableHead>
              <TableHead>
                <button
                  onClick={() => handleSort('totalTokens')}
                  className="text-[11px] uppercase tracking-wider font-medium text-muted-foreground hover:text-foreground"
                >
                  Tokens{sortIndicator('totalTokens')}
                </button>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredRows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                  No rows match the current search.
                </TableCell>
              </TableRow>
            ) : (
              filteredRows.map((row) => (
                <TableRow key={row.dimension} className="even:bg-muted/20">
                  <TableCell className="font-medium">
                    {row.dimension && row.dimension !== EMPTY_VALUE ? (
                      formatCellValue(row.dimension)
                    ) : (
                      <span className="italic text-muted-foreground/60">(empty)</span>
                    )}
                  </TableCell>
                  <TableCell className="tabular-mono">{formatInteger(row.requestCount)}</TableCell>
                  <TableCell className="tabular-mono">
                    {formatPercentage(row.serverErrorRate)}
                  </TableCell>
                  <TableCell className="tabular-mono">{formatPercentage(row.skipRate)}</TableCell>
                  <TableCell className="tabular-mono">{formatDuration(row.p95LatencyMs)}</TableCell>
                  <TableCell className="tabular-mono">
                    {formatCompactNumber(row.totalTokens)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
