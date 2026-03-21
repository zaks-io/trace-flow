'use client';

import { ArrowUpDown, ChevronDown, ChevronUp, Layers } from 'lucide-react';
import { type OperationLeaderboardRow } from '@/components/usage/types';
import { formatCurrency, formatDuration, formatNumber } from '@/lib/format';
import { getAggregateCacheHitRate, getCostPerRequest } from '@/lib/operations';
import { formatCacheHitRate, getCacheHitRateAccent } from '@/lib/cacheMetrics';
import type { LeaderboardSortKey } from './useOperationsFilters';

const CACHE_RATE_COLORS = {
  green: 'text-emerald-500',
  amber: 'text-amber-500',
  red: 'text-red-400',
  zinc: 'text-muted-foreground',
} as const;

function SortIcon({ col, sortKey, sortDesc }: { col: string; sortKey: string; sortDesc: boolean }) {
  if (sortKey !== col) return <ArrowUpDown className="ml-1 inline h-3 w-3 opacity-40" />;
  return sortDesc ? (
    <ChevronDown className="ml-1 inline h-3 w-3" />
  ) : (
    <ChevronUp className="ml-1 inline h-3 w-3" />
  );
}

function ProportionBar({ value, max }: { value: number; max: number }) {
  if (max === 0 || value === 0) return null;
  const pct = Math.min((value / max) * 100, 100);
  return (
    <div className="absolute inset-y-0 left-0 opacity-[0.06]" style={{ width: `${pct}%` }}>
      <div className="h-full bg-foreground" />
    </div>
  );
}

type LeaderboardTableProps = {
  data: OperationLeaderboardRow[];
  selectedOperation: string;
  onSelectOperation: (operation: string) => void;
  sortKey: LeaderboardSortKey;
  sortDesc: boolean;
  onSort: (key: LeaderboardSortKey) => void;
};

export function LeaderboardTable({
  data,
  selectedOperation,
  onSelectOperation,
  sortKey,
  sortDesc,
  onSort,
}: LeaderboardTableProps) {
  if (data.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-12 text-center">
        <Layers className="h-8 w-8 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">No operation data available for this range.</p>
      </div>
    );
  }

  const maxRequests = Math.max(...data.map((r) => r.request_count));

  const cols: { key: LeaderboardSortKey; label: string }[] = [
    { key: 'request_count', label: 'Requests' },
    { key: 'total_cost_usd', label: 'Cost' },
    { key: 'cost_per_request', label: 'Cost / Req' },
    { key: 'cache_hit_rate', label: 'Cache Hit' },
    { key: 'avg_duration_ms', label: 'Avg' },
    { key: 'p95_duration_ms', label: 'P95' },
  ];

  return (
    <div className="overflow-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th className="pb-2 pl-3 font-medium">Operation</th>
            {cols.map((col) => (
              <th
                key={col.key}
                className="cursor-pointer select-none pb-2 text-right font-medium transition-colors hover:text-foreground"
                onClick={() => onSort(col.key)}
              >
                {col.label}
                <SortIcon col={col.key} sortKey={sortKey} sortDesc={sortDesc} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row) => {
            const isSelected = row.operation === selectedOperation;
            const cacheHitRate = getAggregateCacheHitRate(row);
            const costPerRequest = getCostPerRequest(row);
            const cacheAccent = getCacheHitRateAccent(cacheHitRate);

            return (
              <tr
                key={row.operation}
                onClick={() => onSelectOperation(row.operation)}
                className={`group relative cursor-pointer border-b border-border/50 transition-colors ${
                  isSelected ? 'bg-primary/5 hover:bg-primary/8' : 'hover:bg-muted/30'
                }`}
              >
                <td className="relative py-2.5 pl-3 font-medium text-foreground">
                  <ProportionBar value={row.request_count} max={maxRequests} />
                  {isSelected && (
                    <span className="absolute inset-y-0 left-0 w-[3px] rounded-r bg-primary" />
                  )}
                  <span className="relative z-10">{row.operation}</span>
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
