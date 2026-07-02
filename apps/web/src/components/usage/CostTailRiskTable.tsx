'use client';

import { formatCurrency, formatNumber } from '@/lib/format';
import type { CostTailRiskRow } from './types';
import {
  MIN_TAIL_RISK_REQUESTS,
  formatRatio,
  isTailRiskInsufficient,
  usageSliceLabel,
} from './usageRisk';

export function CostTailRiskTable({
  data,
  apiKeyMap,
}: {
  data: CostTailRiskRow[];
  apiKeyMap: Map<string, string>;
}) {
  if (!data || data.length === 0) {
    return <p className="text-sm text-muted-foreground">No tail-risk data for this filter.</p>;
  }

  return (
    <div className="overflow-auto">
      <table className="w-full min-w-[680px] text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th className="pb-2 font-medium">Slice</th>
            <th className="pb-2 text-right font-medium">Requests</th>
            <th className="pb-2 text-right font-medium">P50</th>
            <th className="pb-2 text-right font-medium">P95</th>
            <th className="pb-2 text-right font-medium">P99</th>
            <th className="pb-2 text-right font-medium">Max</th>
            <th className="pb-2 text-right font-medium">P99/P50</th>
          </tr>
        </thead>
        <tbody>
          {data.map((row) => {
            const label = usageSliceLabel(row);
            const thinSample = isTailRiskInsufficient(row);
            const apiKeyLabel = apiKeyMap.get(row.api_key) ?? row.api_key;

            return (
              <tr key={rowKey(row)} className="border-b border-border/50">
                <td className="max-w-[260px] py-2 pr-4">
                  <div className="truncate font-medium text-foreground">{label.primary}</div>
                  <div className="truncate text-xs text-muted-foreground">{label.secondary}</div>
                  <div className="truncate text-[11px] text-muted-foreground/80">
                    {apiKeyLabel}
                    {row.baggage_user_id ? ` / ${row.baggage_user_id}` : ''}
                  </div>
                </td>
                <td className="py-2 text-right font-mono text-muted-foreground">
                  {formatNumber(row.request_count)}
                </td>
                <td className="py-2 text-right font-mono text-muted-foreground">
                  {formatCurrency(row.cost_p50_usd)}
                </td>
                <td className="py-2 text-right font-mono text-muted-foreground">
                  {formatCurrency(row.cost_p95_usd)}
                </td>
                <td className="py-2 text-right font-mono text-foreground">
                  {formatCurrency(row.cost_p99_usd)}
                </td>
                <td className="py-2 text-right font-mono text-muted-foreground">
                  {formatCurrency(row.cost_max_usd)}
                </td>
                <td className="py-2 text-right">
                  <div className="font-mono text-foreground">{formatRatio(row.p99_p50_ratio)}</div>
                  {thinSample && (
                    <div className="text-[11px] text-amber-400">need {MIN_TAIL_RISK_REQUESTS}+</div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function rowKey(row: CostTailRiskRow): string {
  return [
    row.api_key,
    row.provider,
    row.model,
    row.operation_name,
    row.baggage_operation,
    row.baggage_user_id,
  ].join('|');
}
