'use client';

import type { ReactNode } from 'react';
import { Check } from 'lucide-react';
import { useOptionalAnalyst } from '@/components/analyst/AnalystContext';
import type { AnalystPageContextReference } from '@/components/analyst/pageContext';
import { cn } from '@/lib/utils';
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
  contextReference,
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
  contextReference?: AnalystPageContextReference;
}) {
  const analyst = useOptionalAnalyst();
  const selectable = Boolean(analyst?.selectionMode && contextReference);
  const selected = contextReference
    ? (analyst?.isReferenceSelected(contextReference) ?? false)
    : false;

  return (
    <div
      role={selectable ? 'button' : undefined}
      tabIndex={selectable ? 0 : undefined}
      aria-pressed={selectable ? selected : undefined}
      onClick={() => {
        if (contextReference && selectable) analyst?.toggleReference(contextReference);
      }}
      onKeyDown={(event) => {
        if (!contextReference || !selectable || (event.key !== 'Enter' && event.key !== ' '))
          return;
        event.preventDefault();
        analyst?.toggleReference(contextReference);
      }}
      className={cn(
        'relative rounded-xl bg-card/40 p-4',
        selectable &&
          'cursor-pointer border border-border/60 transition-colors hover:border-primary/50',
        selected && 'border-primary/70 ring-2 ring-primary/30',
      )}
    >
      {selected && (
        <span className="absolute right-2 top-2 rounded-full bg-primary p-1 text-primary-foreground">
          <Check className="h-3 w-3" />
        </span>
      )}
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
