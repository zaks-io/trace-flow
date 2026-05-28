'use client';

import { ArrowDown, ArrowUp } from 'lucide-react';
import { formatCurrency, formatNumber, formatPercent } from '@/lib/format';
import { computeDelta } from './delta';
import type { AgentSummaryRow } from './types';

const COST_CAVEAT =
  'Agent Session Authoring Cost is an API-equivalent estimate, not provider spend. Coverage is the share of billable turns that carry a price; some sources (notably Cursor) report only partial economics, so the figure is a lower bound.';

function DeltaBadge({ delta, invert }: { delta: number | null; invert?: boolean }) {
  if (delta === null || !Number.isFinite(delta) || Math.abs(delta) < 0.05) {
    return <span className="text-xs text-muted-foreground">— vs prior</span>;
  }
  const up = delta > 0;
  // For cost, an increase is unfavorable (invert); for volume metrics it is neutral-positive.
  const favorable = invert ? !up : up;
  const Arrow = up ? ArrowUp : ArrowDown;
  return (
    <span
      className={`flex items-center gap-0.5 text-xs font-medium ${
        favorable ? 'text-emerald-500' : 'text-red-400'
      }`}
    >
      <Arrow className="h-3 w-3" />
      {Math.abs(delta).toFixed(0)}%
      <span className="font-normal text-muted-foreground">vs prior</span>
    </span>
  );
}

function KpiCard({
  label,
  value,
  delta,
  invertDelta,
  chip,
  chipTitle,
}: {
  label: string;
  value: string;
  delta?: number | null;
  invertDelta?: boolean;
  chip?: string;
  chipTitle?: string;
}) {
  return (
    <div className="rounded-xl bg-card/40 p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="mt-1 flex items-baseline gap-2">
        <p className="font-mono text-2xl font-semibold tabular-nums text-foreground">{value}</p>
        {chip && (
          <span
            className="cursor-help rounded-full border border-border px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
            title={chipTitle}
          >
            {chip}
          </span>
        )}
      </div>
      {delta !== undefined && (
        <div className="mt-2">
          <DeltaBadge delta={delta} invert={invertDelta} />
        </div>
      )}
    </div>
  );
}

export function AgentKpiCards({ summary }: { summary: AgentSummaryRow }) {
  const coverageLabel =
    summary.coverage_pct == null ? null : `${formatPercent(summary.coverage_pct * 100)} priced`;

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <KpiCard
        label="Est. Cost"
        value={formatCurrency(summary.estimated_cost_usd)}
        delta={computeDelta(summary.estimated_cost_usd, summary.prior_cost_usd)}
        invertDelta
        chip={coverageLabel ?? undefined}
        chipTitle={COST_CAVEAT}
      />
      <KpiCard
        label="Tokens"
        value={formatNumber(summary.total_tokens)}
        delta={computeDelta(summary.total_tokens, summary.prior_total_tokens)}
      />
      <KpiCard
        label="Messages"
        value={formatNumber(summary.message_count)}
        delta={computeDelta(summary.message_count, summary.prior_message_count)}
      />
      <KpiCard
        label="Sessions"
        value={formatNumber(summary.session_count)}
        delta={computeDelta(summary.session_count, summary.prior_session_count)}
      />
    </div>
  );
}
