'use client';

import { useState, useMemo, useCallback } from 'react';
import { ChevronDown, ChevronUp, ArrowUpDown } from 'lucide-react';
import { formatNumber, formatCurrency, formatPercent, formatDuration } from '@/lib/format';
import type { ModelRow, ModelSortKey } from './types';

export function ModelComparisonTable({ data }: { data: ModelRow[] }) {
  const [sortKey, setSortKey] = useState<ModelSortKey>('total_cost_usd');
  const [sortDesc, setSortDesc] = useState(true);

  const handleSort = useCallback(
    (key: ModelSortKey) => {
      if (sortKey === key) {
        setSortDesc((d) => !d);
      } else {
        setSortKey(key);
        setSortDesc(true);
      }
    },
    [sortKey],
  );

  const sorted = useMemo(() => {
    return [...data].sort((a, b) => {
      const aVal = a[sortKey] ?? 0;
      const bVal = b[sortKey] ?? 0;
      return sortDesc ? bVal - aVal : aVal - bVal;
    });
  }, [data, sortKey, sortDesc]);

  if (!data || data.length === 0) {
    return <p className="text-sm text-muted-foreground">No model data available</p>;
  }

  const SortIcon = ({ col }: { col: ModelSortKey }) => {
    if (sortKey !== col) return <ArrowUpDown className="ml-1 inline h-3 w-3 opacity-40" />;
    return sortDesc ? (
      <ChevronDown className="ml-1 inline h-3 w-3" />
    ) : (
      <ChevronUp className="ml-1 inline h-3 w-3" />
    );
  };

  return (
    <div className="overflow-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th className="pb-2 font-medium">Model</th>
            <th
              className="cursor-pointer pb-2 text-right font-medium"
              onClick={() => handleSort('request_count')}
            >
              Requests
              <SortIcon col="request_count" />
            </th>
            <th
              className="cursor-pointer pb-2 text-right font-medium"
              onClick={() => handleSort('total_cost_usd')}
            >
              Cost
              <SortIcon col="total_cost_usd" />
            </th>
            <th
              className="cursor-pointer pb-2 text-right font-medium"
              onClick={() => handleSort('cost_per_1k_output_tokens')}
            >
              $/1K out
              <SortIcon col="cost_per_1k_output_tokens" />
            </th>
            <th
              className="cursor-pointer pb-2 text-right font-medium"
              onClick={() => handleSort('avg_duration_ms')}
            >
              Avg ms
              <SortIcon col="avg_duration_ms" />
            </th>
            <th
              className="cursor-pointer pb-2 text-right font-medium"
              onClick={() => handleSort('p95_duration_ms')}
            >
              P95 ms
              <SortIcon col="p95_duration_ms" />
            </th>
            <th className="pb-2 text-right font-medium">Cache %</th>
            <th className="pb-2 text-right font-medium">Reasoning %</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const cachePercent =
              row.input_tokens > 0 ? (row.cache_read_input_tokens / row.input_tokens) * 100 : 0;
            const reasoningPercent =
              row.output_tokens > 0 ? (row.reasoning_tokens / row.output_tokens) * 100 : 0;
            return (
              <tr key={row.model} className="border-b border-border/50">
                <td className="py-2 font-medium text-foreground">{row.model}</td>
                <td className="py-2 text-right font-mono text-muted-foreground">
                  {formatNumber(row.request_count)}
                </td>
                <td className="py-2 text-right font-mono text-foreground">
                  {formatCurrency(row.total_cost_usd)}
                </td>
                <td className="py-2 text-right font-mono text-muted-foreground">
                  {row.cost_per_1k_output_tokens != null
                    ? formatCurrency(row.cost_per_1k_output_tokens)
                    : '-'}
                </td>
                <td className="py-2 text-right font-mono text-muted-foreground">
                  {formatDuration(row.avg_duration_ms)}
                </td>
                <td className="py-2 text-right font-mono text-muted-foreground">
                  {formatDuration(row.p95_duration_ms)}
                </td>
                <td className="py-2 text-right font-mono text-muted-foreground">
                  {cachePercent > 0 ? formatPercent(cachePercent) : '-'}
                </td>
                <td className="py-2 text-right font-mono text-muted-foreground">
                  {reasoningPercent > 0 ? formatPercent(reasoningPercent) : '-'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
