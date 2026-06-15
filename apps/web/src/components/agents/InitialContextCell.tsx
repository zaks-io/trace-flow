'use client';

import { formatNumber, formatPercent } from '@/lib/format';
import { cn } from '@/lib/utils';
import { BentoCell } from './BentoCell';
import { computeDelta } from './delta';
import { DeltaBadge } from './DeltaBadge';
import type { AgentContextHealthRow } from './types';

/** Reference budget for the starting-size bar — the attention threshold the context uses. */
function meter(pct: number) {
  return Math.max(0, Math.min(1, pct));
}

/**
 * Q3: is my starting context large? The median first-call context size (system prompt + tools
 * + skills, before any work), plus how often conversations begin already-large. No fabricated
 * system/tools/skills split — the data has no per-component columns, so we don't invent one.
 */
export function InitialContextCell({
  row,
  windowDays,
}: {
  row: AgentContextHealthRow | null;
  windowDays: number;
}) {
  const hasData = row != null && row.session_count > 0;
  const budget = row?.attention_threshold_tokens ?? 0;
  const startSize = row?.first_call_context_p50 ?? 0;
  const fill = budget > 0 ? meter(startSize / budget) : 0;
  const startDelta = row
    ? computeDelta(row.first_call_context_p50, row.prior_first_call_context_p50)
    : null;

  const bands = row
    ? [
        { label: '≥25K', pct: row.pct_bloated_start_25k },
        { label: '≥50K', pct: row.pct_bloated_start_50k },
        { label: '≥100K', pct: row.pct_bloated_start_100k },
      ]
    : [];

  return (
    <BentoCell
      title="Initial context size"
      hint="system prompt + tools + skills, before any work"
      caveat={`Share of conversations that begin already-large. "Large" bands vs ${formatNumber(budget)}-token budget.`}
    >
      {hasData && row ? (
        <div className="flex h-full flex-col gap-4">
          <div>
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-3xl font-semibold tabular-nums text-foreground">
                {formatNumber(startSize)}
              </span>
              <span className="text-xs text-muted-foreground">median tokens</span>
              <DeltaBadge
                value={startDelta}
                mode="percent"
                invert
                suffix={`vs previous ${windowDays} days`}
                className="ml-auto"
              />
            </div>
            <div className="mt-2 h-2.5 w-full overflow-hidden rounded-full bg-muted/40">
              <div
                className={cn('h-full rounded-full', fill >= 0.75 ? 'bg-amber-500' : 'bg-primary')}
                style={{ width: `${fill * 100}%` }}
              />
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {formatPercent(fill * 100)} of the {formatNumber(budget)}-token budget
            </p>
          </div>

          <div className="grid grid-cols-3 gap-2">
            {bands.map((band) => (
              <BloatMeter key={band.label} label={band.label} pct={band.pct} />
            ))}
          </div>
        </div>
      ) : (
        <p className="flex h-full min-h-[140px] items-center text-sm text-muted-foreground">
          No conversations in this range.
        </p>
      )}
    </BentoCell>
  );
}

function BloatMeter({ label, pct }: { label: string; pct: number }) {
  const hot = pct >= 0.25;
  return (
    <div className="rounded-lg bg-card/60 p-2.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] text-muted-foreground">start {label}</span>
        <span
          className={cn(
            'font-mono text-sm font-semibold tabular-nums',
            hot ? 'text-amber-400' : 'text-foreground',
          )}
        >
          {formatPercent(pct * 100)}
        </span>
      </div>
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted/40">
        <div
          className={cn('h-full rounded-full', hot ? 'bg-amber-500' : 'bg-primary/70')}
          style={{ width: `${meter(pct) * 100}%` }}
        />
      </div>
    </div>
  );
}
