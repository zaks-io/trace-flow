'use client';

import { ArrowDown, ArrowUp } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Period-over-period change indicator. Two callers produce deltas in different units:
 * `computeDelta` (delta.ts) returns an already-×100 percent, while `buildBurnRateStats`'s
 * `*DeltaPct` fields return raw ratios — so the unit must be declared, not assumed, or
 * burn/pace deltas render 100× off.
 */
type DeltaMode = 'percent' | 'ratio';

/** Below this absolute percent the change is noise — render a muted dash instead. */
const DEAD_BAND_PERCENT = 0.05;

export function DeltaBadge({
  value,
  mode = 'percent',
  invert = false,
  suffix = 'vs prior',
  className,
}: {
  /** Percent (mode='percent') or ratio (mode='ratio'); null = no prior baseline. */
  value: number | null;
  mode?: DeltaMode;
  /** When true an increase reads unfavorable (used for cost). */
  invert?: boolean;
  suffix?: string;
  className?: string;
}) {
  if (value === null || !Number.isFinite(value)) {
    return <span className={cn('text-xs text-muted-foreground', className)}>— {suffix}</span>;
  }

  const percent = mode === 'ratio' ? value * 100 : value;
  if (Math.abs(percent) < DEAD_BAND_PERCENT) {
    return <span className={cn('text-xs text-muted-foreground', className)}>— {suffix}</span>;
  }

  const up = percent > 0;
  const favorable = invert ? !up : up;
  const Arrow = up ? ArrowUp : ArrowDown;
  return (
    <span
      className={cn(
        'flex items-center gap-0.5 text-xs font-medium',
        favorable ? 'text-emerald-500' : 'text-red-400',
        className,
      )}
    >
      <Arrow className="h-3 w-3" />
      {Math.abs(percent).toFixed(0)}%
      <span className="font-normal text-muted-foreground">{suffix}</span>
    </span>
  );
}
