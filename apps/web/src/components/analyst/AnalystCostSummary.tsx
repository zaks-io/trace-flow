'use client';

import { useQuery } from 'convex/react';
import { api } from '@trace-flow/convex/_generated/api';
import type { Id } from '@trace-flow/convex/_generated/dataModel';
import { useIsAdmin } from '@/components/admin/AdminContext';
import { formatNumber } from '@/lib/format';

type UsageTotals = { totalTokens: number; totalCost: number; hasCost: boolean };
type ConversationUsage = { analyst: UsageTotals } | null;

export function AnalystCostSummary({ threadId }: { threadId: Id<'analystThreads'> }) {
  const isAdmin = useIsAdmin();
  const summary = useQuery(
    api.analyst.conversationUsageSummary,
    isAdmin ? { threadId } : 'skip',
  ) as ConversationUsage | undefined;

  if (!isAdmin || !summary) return null;

  if (summary.analyst.totalTokens === 0 && !summary.analyst.hasCost) return null;

  return (
    <section className="mt-3 overflow-hidden rounded-lg border border-border/60 bg-muted/30">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border/40 text-[10px] uppercase tracking-wide text-muted-foreground/70">
            {/* Agent column absorbs the slack so Tokens + Cost sit together on the right. */}
            <th className="w-full px-3.5 py-2 text-left font-medium">Agent</th>
            <th className="whitespace-nowrap px-3.5 py-2 text-right font-medium">Tokens</th>
            <th className="whitespace-nowrap px-3.5 py-2 text-right font-medium">Cost</th>
          </tr>
        </thead>
        <tbody>
          <UsageRow label="Analyst" totals={summary.analyst} />
        </tbody>
        <tfoot>
          <UsageRow label="Total" totals={summary.analyst} emphasis />
        </tfoot>
      </table>
    </section>
  );
}

function UsageRow({
  label,
  totals,
  emphasis = false,
}: {
  label: string;
  totals: UsageTotals;
  emphasis?: boolean;
}) {
  return (
    <tr
      className={
        emphasis ? 'border-t border-border/50 font-medium text-foreground' : 'text-foreground/80'
      }
    >
      <td className="px-3.5 py-2 text-left">{label}</td>
      <td className="px-3.5 py-2 text-right font-mono tabular-nums">
        {formatNumber(totals.totalTokens)}
      </td>
      <td className="px-3.5 py-2 text-right font-mono tabular-nums">
        {totals.hasCost ? formatLedgerCost(totals.totalCost) : '—'}
      </td>
    </tr>
  );
}

/** Fixed 4-decimal USD so every row aligns on the decimal point (e.g. $0.0015, $0.0300, $0.1414). */
function formatLedgerCost(value: number): string {
  return `$${value.toFixed(4)}`;
}
