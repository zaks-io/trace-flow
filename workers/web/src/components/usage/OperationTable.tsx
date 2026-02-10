import { formatNumber, formatCurrency, formatDuration } from '@/lib/format';
import type { OperationRow } from './types';

export function OperationTable({ data }: { data: OperationRow[] }) {
  if (!data || data.length === 0) {
    return <p className="text-sm text-muted-foreground">No operation data available</p>;
  }

  return (
    <div className="overflow-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th className="pb-2 font-medium">Operation</th>
            <th className="pb-2 text-right font-medium">Requests</th>
            <th className="pb-2 text-right font-medium">Cost</th>
            <th className="pb-2 text-right font-medium">Avg ms</th>
            <th className="pb-2 text-right font-medium">P95 ms</th>
          </tr>
        </thead>
        <tbody>
          {data.map((row) => (
            <tr key={row.operation} className="border-b border-border/50">
              <td className="py-2 font-medium text-foreground">{row.operation}</td>
              <td className="py-2 text-right font-mono text-muted-foreground">
                {formatNumber(row.request_count)}
              </td>
              <td className="py-2 text-right font-mono text-foreground">
                {formatCurrency(row.total_cost_usd)}
              </td>
              <td className="py-2 text-right font-mono text-muted-foreground">
                {formatDuration(row.avg_duration_ms)}
              </td>
              <td className="py-2 text-right font-mono text-muted-foreground">
                {formatDuration(row.p95_duration_ms)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
