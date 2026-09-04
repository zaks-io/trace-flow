import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { QueryRunnerResult } from './types';

export function QueryResultTable({ result }: { result: QueryRunnerResult | null }) {
  if (!result) return null;

  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <div className="border-b border-border bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
        {result.rowCount} row{result.rowCount === 1 ? '' : 's'}
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            {result.columns.map((column) => (
              <TableHead key={column.name}>{column.name}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {result.rows.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={result.columns.length}
                className="py-8 text-center text-muted-foreground"
              >
                Query returned no rows.
              </TableCell>
            </TableRow>
          ) : (
            result.rows.map((row, index) => (
              <TableRow key={`${index}-${row.join('|')}`}>
                {row.map((cell, cellIndex) => (
                  <TableCell key={`${index}-${cellIndex}`} className="tabular-mono">
                    {cell || ' '}
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
