'use client';

import { useMemo } from 'react';
import { formatCurrency, formatNumber, formatPercent } from '@/lib/format';
import { cn } from '@/lib/utils';
import { BentoCell } from './BentoCell';
import {
  buildSizeBands,
  medianMessagesPerSession,
  throughputVerdict,
  THROUGHPUT_VERDICT_LABEL,
  type SizeBand,
} from './agentSessionSizes';
import type { AgentSessionSizeRow } from './types';

const BAND_COLOR: Record<SizeBand['key'], string> = {
  small: 'var(--color-chart-3)',
  medium: 'var(--color-chart-2)',
  large: 'var(--color-chart-1)',
};

/**
 * Q5: am I doing many small iterations or a few big ones? A single segmented bar splits
 * conversations into small / medium / large by message count, with a plain verdict word and
 * the median messages-per-session. "Throughput" is the metric; the bands carry the shape.
 */
export function VelocityBar({
  row,
  windowDays,
}: {
  row: AgentSessionSizeRow | null;
  windowDays: number;
}) {
  const bands = useMemo(() => (row ? buildSizeBands(row) : []), [row]);
  const hasData = row != null && row.session_count > 0;
  const verdict = row ? throughputVerdict(row) : 'none';
  const median = row ? medianMessagesPerSession(row) : 0;

  return (
    <BentoCell
      title="Throughput"
      hint="conversations by size — many small vs few big"
      caveat={`Bands by messages per session, over the last ${windowDays} days. Cost per band is an estimate (lower bound).`}
    >
      {hasData && row ? (
        <div className="flex h-full flex-col gap-4">
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-semibold tracking-tight text-foreground">
                {THROUGHPUT_VERDICT_LABEL[verdict]}
              </span>
              <span className="text-xs text-muted-foreground">conversation mix</span>
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className="font-mono text-2xl font-semibold tabular-nums text-foreground">
                {formatNumber(median)}
              </span>
              <span className="text-xs text-muted-foreground">median messages / session</span>
            </div>
            <div className="ml-auto flex items-baseline gap-1.5">
              <span className="font-mono text-lg font-semibold tabular-nums text-foreground">
                {formatNumber(row.session_count)}
              </span>
              <span className="text-xs text-muted-foreground">conversations</span>
            </div>
          </div>

          <div className="flex h-3.5 w-full overflow-hidden rounded-full bg-muted/30">
            {bands.map((band) =>
              band.share > 0 ? (
                <div
                  key={band.key}
                  className="h-full first:rounded-l-full last:rounded-r-full"
                  style={{ width: `${band.share * 100}%`, backgroundColor: BAND_COLOR[band.key] }}
                  title={`${band.label}: ${formatNumber(band.sessions)} (${formatPercent(band.share * 100)})`}
                />
              ) : null,
            )}
          </div>

          <div className="grid grid-cols-3 gap-3">
            {bands.map((band) => (
              <BandLegend key={band.key} band={band} />
            ))}
          </div>
        </div>
      ) : (
        <p className="flex h-full min-h-[120px] items-center text-sm text-muted-foreground">
          No conversations in this range.
        </p>
      )}
    </BentoCell>
  );
}

function BandLegend({ band }: { band: SizeBand }) {
  return (
    <div className="rounded-lg bg-card/60 p-2.5">
      <div className="flex items-center gap-1.5">
        <span
          className={cn('h-2 w-2 shrink-0 rounded-full')}
          style={{ backgroundColor: BAND_COLOR[band.key] }}
        />
        <span className="text-[11px] font-medium text-foreground">{band.label}</span>
        <span className="text-[11px] text-muted-foreground">{band.range}</span>
      </div>
      <div className="mt-1 flex items-baseline justify-between">
        <span className="font-mono text-sm font-semibold tabular-nums text-foreground">
          {formatNumber(band.sessions)}
        </span>
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
          {formatPercent(band.share * 100)}
        </span>
      </div>
      <p className="mt-0.5 font-mono text-[11px] tabular-nums text-muted-foreground">
        {formatCurrency(band.costUsd)}
      </p>
    </div>
  );
}
