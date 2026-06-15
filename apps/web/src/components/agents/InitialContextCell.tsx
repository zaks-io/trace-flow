'use client';

import { formatNumber, formatPercent } from '@/lib/format';
import { cn } from '@/lib/utils';
import { BentoCell } from './BentoCell';
import { computeDelta } from './delta';
import { DeltaBadge } from './DeltaBadge';
import type { AgentContextHealthRow } from './types';

/** Axis ceiling for the percentile strip: the max turn, or the threshold if nothing exceeds it. */
function axisMax(row: AgentContextHealthRow): number {
  return Math.max(row.context_max, row.attention_threshold_tokens) || 1;
}

function pos(value: number, max: number): number {
  return Math.max(0, Math.min(1, value / max)) * 100;
}

/**
 * Q3: how many turns are running with a huge context? Counts individual TURNS (not whole
 * conversations) whose context exceeded the threshold (140K default), with true per-turn
 * percentiles plotted against the threshold line and the single worst conversation named.
 * Conversation-level "bloated start" bands are gone — at that grain the number tells you
 * nothing; what matters is which turns are actually over the line.
 */
export function InitialContextCell({
  row,
  windowDays,
}: {
  row: AgentContextHealthRow | null;
  windowDays: number;
}) {
  const hasData = row != null && row.model_call_count > 0;
  const threshold = row?.attention_threshold_tokens ?? 140_000;

  const overDelta = row
    ? computeDelta(row.pct_calls_over_threshold, row.prior_pct_calls_over_threshold)
    : null;

  const max = row ? axisMax(row) : 1;
  const markers = row
    ? ([
        { key: 'p10', label: 'p10', value: row.context_p10 },
        { key: 'p50', label: 'p50', value: row.context_p50 },
        { key: 'p90', label: 'p90', value: row.context_p90 },
        { key: 'p95', label: 'p95', value: row.context_p95 },
        { key: 'max', label: 'max', value: row.context_max },
      ] as const)
    : [];

  return (
    <BentoCell
      title={`Turns over ${formatNumber(threshold)} context`}
      hint="individual turns running with a large context window"
      caveat={`Counts measured assistant turns, not conversations. Per-turn context = input + cache read + cache write. Last ${windowDays} days.`}
    >
      {hasData && row ? (
        <div className="flex h-full flex-col gap-4">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-3xl font-semibold tabular-nums text-foreground">
              {formatNumber(row.calls_over_threshold)}
            </span>
            <span className="text-xs text-muted-foreground">
              of {formatNumber(row.model_call_count)} turns ·{' '}
              {formatPercent(row.pct_calls_over_threshold * 100)}
            </span>
            <DeltaBadge
              value={overDelta}
              mode="percent"
              invert
              suffix={`vs previous ${windowDays} days`}
              className="ml-auto"
            />
          </div>

          <PercentileStrip threshold={threshold} max={max} markers={markers} />

          {row.worst_session_context_max > 0 && (
            <p className="text-[11px] text-muted-foreground">
              Worst conversation peaked at{' '}
              <span className="font-mono font-semibold tabular-nums text-amber-400">
                {formatNumber(row.worst_session_context_max)}
              </span>{' '}
              tokens
              {row.worst_session_calls_over_threshold > 0 && (
                <>
                  {' '}
                  across{' '}
                  <span className="font-mono font-semibold tabular-nums text-foreground">
                    {formatNumber(row.worst_session_calls_over_threshold)}
                  </span>{' '}
                  turns over the line
                </>
              )}
              .
            </p>
          )}
        </div>
      ) : (
        <p className="flex h-full min-h-[140px] items-center text-sm text-muted-foreground">
          No measured turns in this range.
        </p>
      )}
    </BentoCell>
  );
}

function PercentileStrip({
  threshold,
  max,
  markers,
}: {
  threshold: number;
  max: number;
  markers: ReadonlyArray<{ key: string; label: string; value: number }>;
}) {
  const thresholdPos = pos(threshold, max);
  return (
    <div className="pt-5">
      <div className="relative h-2 w-full rounded-full bg-muted/40">
        {/* Over-threshold zone, warm. */}
        <div
          className="absolute inset-y-0 right-0 rounded-r-full bg-amber-500/25"
          style={{ left: `${thresholdPos}%` }}
        />
        {/* The 140K line. */}
        <div
          className="absolute -top-1.5 bottom-[-0.375rem] w-px bg-amber-500"
          style={{ left: `${thresholdPos}%` }}
        >
          <span className="absolute -top-5 left-1/2 -translate-x-1/2 whitespace-nowrap text-[10px] font-medium text-amber-400">
            {formatNumber(threshold)}
          </span>
        </div>
        {markers.map((m) => {
          const over = m.value > threshold;
          return (
            <div
              key={m.key}
              className="absolute -bottom-5 flex -translate-x-1/2 flex-col items-center"
              style={{ left: `${pos(m.value, max)}%` }}
            >
              <span
                className={cn(
                  'h-2 w-2 -translate-y-2 rounded-full ring-2 ring-background',
                  over ? 'bg-amber-500' : 'bg-primary',
                )}
              />
              <span className="text-[10px] text-muted-foreground">{m.label}</span>
              <span
                className={cn(
                  'font-mono text-[10px] tabular-nums',
                  over ? 'text-amber-400' : 'text-foreground',
                )}
              >
                {formatNumber(m.value)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
