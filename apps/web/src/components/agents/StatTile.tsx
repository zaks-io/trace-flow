'use client';

import type { ReactNode } from 'react';
import { DeltaBadge } from './DeltaBadge';

/**
 * A single headline stat: a fact label, a mono numeric value, an optional vs-prior delta,
 * and an optional caveat chip. The building block of the Overview glance strip.
 */
export function StatTile({
  label,
  value,
  sub,
  delta,
  deltaMode = 'percent',
  invertDelta,
  chip,
  chipTitle,
}: {
  label: string;
  value: string;
  /** Secondary line under the value (e.g. a rate or context). */
  sub?: ReactNode;
  /** Percent (deltaMode='percent') or ratio (deltaMode='ratio'); null = no prior baseline. */
  delta?: number | null;
  deltaMode?: 'percent' | 'ratio';
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
      {sub && <p className="mt-1 text-xs text-muted-foreground">{sub}</p>}
      {delta !== undefined && (
        <div className="mt-2">
          <DeltaBadge value={delta} mode={deltaMode} invert={invertDelta} />
        </div>
      )}
    </div>
  );
}
