'use client';

import { formatNumber } from '@/lib/format';
import type { TokenRatioDriftRow } from './types';
import {
  formatRatio,
  formatSignedPercentDelta,
  formatTokensPerRequest,
  isTokenRatioInsufficient,
  usageSliceLabel,
} from './usageRisk';

export function TokenRatioDriftTable({ data }: { data: TokenRatioDriftRow[] }) {
  if (!data || data.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No token-ratio drift data for this filter.</p>
    );
  }

  const allInsufficient = data.every(isTokenRatioInsufficient);

  return (
    <div className="space-y-3">
      {allInsufficient && (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          Baseline windows need at least 3 matching requests before drift is reliable.
        </p>
      )}

      <div className="overflow-auto">
        <table className="w-full min-w-[780px] text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="pb-2 font-medium">Slice</th>
              <th className="pb-2 text-right font-medium">Requests</th>
              <th className="pb-2 text-right font-medium">Out/In</th>
              <th className="pb-2 text-right font-medium">Baseline</th>
              <th className="pb-2 text-right font-medium">Delta</th>
              <th className="pb-2 text-right font-medium">Input/Req</th>
              <th className="pb-2 text-right font-medium">Baseline</th>
              <th className="pb-2 text-right font-medium">Delta</th>
              <th className="pb-2 text-right font-medium">State</th>
            </tr>
          </thead>
          <tbody>
            {data.map((row) => {
              const label = usageSliceLabel(row);
              const insufficient = isTokenRatioInsufficient(row);

              return (
                <tr key={rowKey(row)} className="border-b border-border/50">
                  <td className="max-w-[230px] py-2 pr-4">
                    <div className="truncate font-medium text-foreground">{label.primary}</div>
                    <div className="truncate text-xs text-muted-foreground">{label.secondary}</div>
                  </td>
                  <td className="py-2 text-right font-mono text-muted-foreground">
                    <div>{formatNumber(row.request_count)}</div>
                    <div className="text-[11px]">
                      base {formatNumber(row.baseline_request_count)}
                    </div>
                  </td>
                  <td className="py-2 text-right font-mono text-foreground">
                    {formatRatio(row.current_output_input_ratio)}
                  </td>
                  <td className="py-2 text-right font-mono text-muted-foreground">
                    {formatRatio(row.baseline_output_input_ratio)}
                  </td>
                  <td className="py-2 text-right font-mono text-foreground">
                    {formatSignedPercentDelta(row.output_input_ratio_percent_delta)}
                  </td>
                  <td className="py-2 text-right font-mono text-foreground">
                    {formatTokensPerRequest(row.current_input_tokens_per_request)}
                  </td>
                  <td className="py-2 text-right font-mono text-muted-foreground">
                    {formatTokensPerRequest(row.baseline_input_tokens_per_request)}
                  </td>
                  <td className="py-2 text-right font-mono text-foreground">
                    {formatSignedPercentDelta(row.input_tokens_per_request_percent_delta)}
                  </td>
                  <td className="py-2 text-right">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                        insufficient
                          ? 'bg-amber-500/10 text-amber-300'
                          : 'bg-emerald-500/10 text-emerald-300'
                      }`}
                    >
                      {insufficient ? 'insufficient' : 'ok'}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function rowKey(row: TokenRatioDriftRow): string {
  return [
    row.api_key,
    row.provider,
    row.model,
    row.operation_name,
    row.baggage_operation,
    row.baggage_user_id,
  ].join('|');
}
