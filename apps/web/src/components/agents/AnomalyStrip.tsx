'use client';

import { useMemo } from 'react';
import { formatNumber, formatPercent } from '@/lib/format';
import { cn } from '@/lib/utils';
import { BentoCell } from './BentoCell';
import type { AttentionSignal, AttentionSeverity } from './buildAttentionSignals';
import type { FailureLeaderboardRow, ToolDeltaRow } from './types';

/** Cap the resting strip so it stays a glance; the rest fold into a "+N more" line. */
const VISIBLE_SIGNALS = 4;

const SEVERITY_DOT: Record<AttentionSeverity, string> = {
  critical: 'bg-destructive',
  warn: 'bg-amber-500',
};

/**
 * Q6: anything to worry about? A terse always-present strip of the signals that crossed a
 * threshold (cost spikes, low pricing coverage, context bloat, failing tools) ranked
 * critical-first. These are prior-window movers and threshold crossings, NOT a statistical
 * anomaly model. When nothing crosses, it shows one calm line and never disappears. Expand
 * for the full tool period-over-period and failure tables.
 */
export function AnomalyStrip({
  signals,
  deltas,
  failures,
  windowDays,
  expanded,
  onToggleExpand,
}: {
  signals: AttentionSignal[];
  deltas: ToolDeltaRow[];
  failures: FailureLeaderboardRow[];
  windowDays: number;
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  const visible = signals.slice(0, VISIBLE_SIGNALS);
  const hidden = signals.length - visible.length;

  const movers = useMemo(
    () => [...deltas].sort((a, b) => Math.abs(b.count_delta) - Math.abs(a.count_delta)).slice(0, 8),
    [deltas],
  );
  const worstFailures = useMemo(
    () =>
      [...failures]
        .filter((row) => row.failure_rate != null)
        .sort((a, b) => (b.failure_rate ?? 0) - (a.failure_rate ?? 0))
        .slice(0, 8),
    [failures],
  );

  return (
    <BentoCell
      title="Anomalies"
      hint={`movers and threshold crossings vs the previous ${windowDays} days`}
      expandable
      expanded={expanded}
      onToggleExpand={onToggleExpand}
      caveat="Threshold crossings and prior-window movers, not a statistical anomaly model."
      expandedContent={
        <div className="grid gap-6 lg:grid-cols-2">
          <ToolMovers rows={movers} />
          <FailureRows rows={worstFailures} />
        </div>
      }
    >
      {signals.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="h-2 w-2 rounded-full bg-emerald-500/70" />
          No anomalies in this window.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {visible.map((signal) => (
            <li key={signal.id} className="flex items-start gap-2.5">
              <span
                className={cn(
                  'mt-1.5 h-2 w-2 shrink-0 rounded-full',
                  SEVERITY_DOT[signal.severity],
                )}
              />
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">{signal.label}</p>
                <p className="text-xs text-muted-foreground">{signal.detail}</p>
              </div>
            </li>
          ))}
          {hidden > 0 && (
            <li className="pl-[18px] text-xs text-muted-foreground">+{hidden} more</li>
          )}
        </ul>
      )}
    </BentoCell>
  );
}

function ToolMovers({ rows }: { rows: ToolDeltaRow[] }) {
  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Tool usage movers
      </h3>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No tool activity to compare across periods.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border/60 text-left text-xs text-muted-foreground">
              <th className="pb-1.5 font-medium">Tool</th>
              <th className="pb-1.5 text-right font-medium">Current</th>
              <th className="pb-1.5 text-right font-medium">Prior</th>
              <th className="pb-1.5 text-right font-medium">Δ Uses</th>
              <th className="pb-1.5 text-right font-medium">Δ Failures</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={`${row.tool_name}:${row.command_family}`}
                className="border-b border-border/40"
              >
                <td className="py-1.5 font-medium text-foreground">
                  {row.tool_name}
                  {row.command_family ? (
                    <span className="ml-1 text-muted-foreground">{row.command_family}</span>
                  ) : null}
                </td>
                <td className="py-1.5 text-right font-mono tabular-nums text-muted-foreground">
                  {formatNumber(row.current_count)}
                </td>
                <td className="py-1.5 text-right font-mono tabular-nums text-muted-foreground">
                  {formatNumber(row.prior_count)}
                </td>
                <DeltaCell value={row.count_delta} />
                <DeltaCell value={row.failure_delta} invert />
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function FailureRows({ rows }: { rows: FailureLeaderboardRow[] }) {
  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Highest failure rates
      </h3>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No failing tools in this window.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border/60 text-left text-xs text-muted-foreground">
              <th className="pb-1.5 font-medium">Tool</th>
              <th className="pb-1.5 text-right font-medium">Events</th>
              <th className="pb-1.5 text-right font-medium">Failures</th>
              <th className="pb-1.5 text-right font-medium">Failure rate</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={`${row.tool_name}:${row.command_family}`}
                className="border-b border-border/40"
              >
                <td className="py-1.5 font-medium text-foreground">
                  {row.tool_name}
                  {row.command_family ? (
                    <span className="ml-1 text-muted-foreground">{row.command_family}</span>
                  ) : null}
                </td>
                <td className="py-1.5 text-right font-mono tabular-nums text-muted-foreground">
                  {formatNumber(row.event_count)}
                </td>
                <td className="py-1.5 text-right font-mono tabular-nums text-muted-foreground">
                  {formatNumber(row.failure_count)}
                </td>
                <td
                  className={cn(
                    'py-1.5 text-right font-mono tabular-nums',
                    failureAccent(row.failure_rate),
                  )}
                >
                  {row.failure_rate == null ? '—' : formatPercent(row.failure_rate * 100)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function DeltaCell({ value, invert = false }: { value: number; invert?: boolean }) {
  const positiveIsGood = !invert;
  const accent =
    value === 0
      ? 'text-muted-foreground'
      : value > 0 === positiveIsGood
        ? 'text-emerald-500'
        : 'text-red-400';
  return (
    <td className={cn('py-1.5 text-right font-mono tabular-nums', accent)}>
      {value > 0 ? '+' : ''}
      {formatNumber(value)}
    </td>
  );
}

function failureAccent(rate: number | null): string {
  if (rate == null) return 'text-muted-foreground';
  if (rate >= 0.25) return 'text-red-400';
  if (rate >= 0.1) return 'text-amber-500';
  return 'text-emerald-500';
}
