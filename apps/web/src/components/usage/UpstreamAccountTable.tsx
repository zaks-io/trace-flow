import Link from 'next/link';
import { cn } from '@/lib/utils';
import { AccountIdentityBadge } from '@/components/shared/AccountIdentityBadge';
import { formatCurrency, formatDuration, formatNumber } from '@/lib/format';
import {
  accountLabel,
  accountRequestsHref,
  installationLabel,
  tryParseAccountKey,
  UNRECOGNIZED_ACCOUNT_LABEL,
  type AccountDrilldownFilters,
} from '@/lib/upstreamAccount';
import type { UpstreamAccountRow } from './types';
import {
  costGapNote,
  estimatedCost,
  planLabel,
  reasoningShare,
  successRate,
  tokenCell,
  usageGapNote,
} from './upstreamAccountUsage';

// Non-overlapping buckets that add up to Total (plus unclassified); input includes cache and
// output includes reasoning, so showing those totals beside their parts invites double counting.
const TOKEN_COLUMNS = [
  ['Uncached input', 'uncached_input_tokens'],
  ['Cache read', 'cache_read_input_tokens'],
  ['Cache write', 'cache_creation_input_tokens'],
  ['Output', 'output_tokens'],
  ['Total', 'total_tokens'],
] as const;

export function UpstreamAccountTable({
  data,
  filters,
}: {
  data: UpstreamAccountRow[];
  filters: AccountDrilldownFilters;
}) {
  return (
    <div className="overflow-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th className="pb-2 font-medium">Account</th>
            <th className="pb-2 font-medium">Identity</th>
            <th className="pb-2 font-medium">Provider</th>
            <th className="pb-2 text-right font-medium">Requests</th>
            <th className="pb-2 text-right font-medium">Failed</th>
            <th className="pb-2 text-right font-medium">Success rate</th>
            {TOKEN_COLUMNS.map(([label]) => (
              <th key={label} className="pb-2 text-right font-medium">
                {label}
              </th>
            ))}
            <th className="pb-2 text-right font-medium">Reasoning %</th>
            <th className="pb-2 text-right font-medium">Avg TTFT</th>
            <th className="pb-2 text-right font-medium">Est. cost</th>
          </tr>
        </thead>
        <tbody>
          {data.map((row) => {
            const account = tryParseAccountKey(row.account_key);
            const label = account ? accountLabel(account) : UNRECOGNIZED_ACCOUNT_LABEL;
            const usageNote = usageGapNote(row);
            const costNote = costGapNote(row);
            const plan = planLabel(row);
            return (
              <tr key={row.account_key} className="border-b border-border/50 align-top">
                <td className="py-2">
                  <Link
                    href={accountRequestsHref(row.account_key, filters)}
                    className={cn(
                      'font-medium hover:underline',
                      account ? 'text-primary' : 'text-destructive',
                    )}
                    aria-label={`View requests for ${label}`}
                    title={account ? undefined : row.account_key}
                  >
                    {label}
                  </Link>
                  {plan && <div className="text-xs text-foreground">{plan}</div>}
                  {account && account.coverage !== 'unknown' && (
                    <div className="text-[11px] text-muted-foreground">
                      {installationLabel(account)}
                    </div>
                  )}
                  {usageNote && <div className="text-[11px] text-amber-400">{usageNote}</div>}
                </td>
                <td className="py-2">
                  {account ? (
                    <AccountIdentityBadge coverage={account.coverage} />
                  ) : (
                    <span className="text-muted-foreground/50">-</span>
                  )}
                </td>
                <td className="py-2 text-muted-foreground">{account?.provider ?? '-'}</td>
                <td className="py-2 text-right font-mono text-muted-foreground">
                  {formatNumber(row.request_count)}
                </td>
                <td className="py-2 text-right font-mono text-muted-foreground">
                  {formatNumber(row.error_count)}
                </td>
                <td className="py-2 text-right font-mono text-muted-foreground">
                  {successRate(row)}
                </td>
                {TOKEN_COLUMNS.map(([label, field]) => (
                  <td key={label} className="py-2 text-right font-mono text-muted-foreground">
                    {tokenCell(row, row[field])}
                  </td>
                ))}
                <td className="py-2 text-right font-mono text-muted-foreground">
                  {reasoningShare(row)}
                </td>
                <td className="py-2 text-right font-mono text-muted-foreground">
                  {formatDuration(row.avg_ttft_ms)}
                </td>
                <td className="py-2 text-right">
                  <div className="font-mono text-foreground">
                    {formatCurrency(estimatedCost(row))}
                  </div>
                  {costNote && <div className="text-[11px] text-amber-400">{costNote}</div>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
