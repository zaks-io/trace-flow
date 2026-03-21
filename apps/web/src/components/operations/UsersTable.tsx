'use client';

import { Users } from 'lucide-react';
import { type OperationUserRow } from '@/components/usage/types';
import { formatCurrency, formatDuration, formatNumber } from '@/lib/format';
import { getAggregateCacheHitRate, getCostPerRequest } from '@/lib/operations';
import { formatCacheHitRate, getCacheHitRateAccent } from '@/lib/cacheMetrics';

const CACHE_RATE_COLORS = {
  green: 'text-emerald-500',
  amber: 'text-amber-500',
  red: 'text-red-400',
  zinc: 'text-muted-foreground',
} as const;

function ProportionBar({ value, max }: { value: number; max: number }) {
  if (max === 0 || value === 0) return null;
  const pct = Math.min((value / max) * 100, 100);
  return (
    <div className="absolute inset-y-0 left-0 opacity-[0.06]" style={{ width: `${pct}%` }}>
      <div className="h-full bg-foreground" />
    </div>
  );
}

export function UsersTable({ data }: { data: OperationUserRow[] }) {
  if (data.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-12 text-center">
        <Users className="h-8 w-8 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">
          No <code className="rounded bg-muted px-1 py-0.5 text-xs">baggage.user_id</code> values
          were captured for this operation.
        </p>
      </div>
    );
  }

  const maxRequests = Math.max(...data.map((r) => r.request_count));

  return (
    <div className="overflow-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th className="pb-2 pl-3 font-medium">User ID</th>
            <th className="pb-2 text-right font-medium">Requests</th>
            <th className="pb-2 text-right font-medium">Cost</th>
            <th className="pb-2 text-right font-medium">Cost / Req</th>
            <th className="pb-2 text-right font-medium">Cache Hit</th>
            <th className="pb-2 text-right font-medium">Avg</th>
            <th className="pb-2 text-right font-medium">P95</th>
          </tr>
        </thead>
        <tbody>
          {data.map((row) => {
            const cacheHitRate = getAggregateCacheHitRate(row);
            const costPerRequest = getCostPerRequest(row);
            const cacheAccent = getCacheHitRateAccent(cacheHitRate);

            return (
              <tr
                key={row.baggage_user_id}
                className="relative border-b border-border/50 transition-colors hover:bg-muted/30"
              >
                <td className="relative py-2.5 pl-3 font-mono text-foreground">
                  <ProportionBar value={row.request_count} max={maxRequests} />
                  <span className="relative z-10">{row.baggage_user_id}</span>
                </td>
                <td className="py-2.5 text-right font-mono text-muted-foreground">
                  {formatNumber(row.request_count)}
                </td>
                <td className="py-2.5 text-right font-mono text-foreground">
                  {formatCurrency(row.total_cost_usd)}
                </td>
                <td className="py-2.5 text-right font-mono text-muted-foreground">
                  {formatCurrency(costPerRequest)}
                </td>
                <td className={`py-2.5 text-right font-mono ${CACHE_RATE_COLORS[cacheAccent]}`}>
                  {formatCacheHitRate(cacheHitRate)}
                </td>
                <td className="py-2.5 text-right font-mono text-muted-foreground">
                  {formatDuration(row.avg_duration_ms)}
                </td>
                <td className="py-2.5 text-right font-mono text-muted-foreground">
                  {formatDuration(row.p95_duration_ms)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
