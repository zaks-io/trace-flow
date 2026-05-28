'use client';

import { AlertTriangle } from 'lucide-react';
import { formatCurrency, formatNumber, formatPercent } from '@/lib/format';
import type { CoverageRow } from './types';

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl bg-card/40 p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 font-mono text-2xl font-semibold tabular-nums text-foreground">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function CoverageHeader({
  coverage,
  isPartial,
}: {
  coverage: CoverageRow;
  isPartial: boolean;
}) {
  const coverageLabel =
    coverage.coverage_pct == null ? '—' : formatPercent(coverage.coverage_pct * 100);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard
          label="Estimated cost"
          value={formatCurrency(coverage.estimated_cost_usd)}
          hint="Estimated from token usage, not billed spend."
        />
        <StatCard
          label="Priced-token coverage"
          value={coverageLabel}
          hint={`${formatNumber(coverage.priced_message_count)} of ${formatNumber(
            coverage.billable_message_count,
          )} billable turns priced`}
        />
        <StatCard
          label="Messages"
          value={formatNumber(coverage.message_count)}
          hint={`${formatNumber(coverage.billable_message_count)} billable (assistant) turns`}
        />
      </div>

      {isPartial && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-500">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            Partial coverage: {coverageLabel} of billable turns carry a price. Unpriced turns
            (unknown model or missing token data) are excluded from the estimated cost, so the
            dollar figure is a lower bound.
          </p>
        </div>
      )}
    </div>
  );
}
