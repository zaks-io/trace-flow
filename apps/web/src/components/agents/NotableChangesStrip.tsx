'use client';

import { useMemo } from 'react';
import { formatCurrency, formatNumber, formatPercent } from '@/lib/format';
import { cn } from '@/lib/utils';
import { BentoCell } from './BentoCell';
import type { AttentionSignal, AttentionSeverity } from './buildAttentionSignals';
import type { AgentNotableChangeRow, FailureLeaderboardRow, ToolDeltaRow } from './types';

/** Cap the resting strip so it stays a glance; the rest fold into a "+N more" line. */
const VISIBLE_SIGNALS = 4;
/** Movers shown in the expanded cost-mover table. */
const VISIBLE_MOVERS = 10;

const SEVERITY_DOT: Record<AttentionSeverity, string> = {
  critical: 'bg-destructive',
  warn: 'bg-amber-500',
};

/**
 * Q6: anything worth a look? A terse always-present strip of facts that crossed a threshold
 * (spend pace above the 28-day average, low pricing coverage, per-turn context pressure,
 * failing tools), ranked critical-first. These are period-over-period movements and threshold
 * crossings reported as facts — deliberately NOT called "anomalies", because nothing here is a
 * statistical-outlier claim. When nothing crosses, it shows one calm line and never disappears.
 * Expand for the per-repo cost movers (vs the trailing-28-day daily baseline) plus the tool
 * usage and failure detail.
 */
export function AnomalyStrip({
  signals,
  notableTotal,
  notableByRepo,
  deltas,
  failures,
  windowDays,
  labelFor,
  expanded,
  onToggleExpand,
}: {
  signals: AttentionSignal[];
  notableTotal: AgentNotableChangeRow | null;
  notableByRepo: AgentNotableChangeRow[];
  deltas: ToolDeltaRow[];
  failures: FailureLeaderboardRow[];
  windowDays: number;
  labelFor: (value: string) => string;
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  const visible = signals.slice(0, VISIBLE_SIGNALS);
  const hidden = signals.length - visible.length;

  const movers = useMemo(
    () =>
      [...notableByRepo]
        .filter((row) => row.group_value !== '')
        .sort((a, b) => Math.abs(b.cost_delta_usd) - Math.abs(a.cost_delta_usd))
        .slice(0, VISIBLE_MOVERS),
    [notableByRepo],
  );
  const toolMovers = useMemo(
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
      title="Notable changes"
      hint={`movers and threshold crossings vs the previous ${windowDays} days`}
      expandable
      expanded={expanded}
      onToggleExpand={onToggleExpand}
      caveat="Period-over-period facts and threshold crossings, not a statistical anomaly model. Spend pace is compared against a trailing 28-day daily average."
      expandedContent={
        <div className="flex flex-col gap-6">
          <CostMovers rows={movers} labelFor={labelFor} />
          <div className="grid gap-6 lg:grid-cols-2">
            <ToolMovers rows={toolMovers} />
            <FailureRows rows={worstFailures} />
          </div>
        </div>
      }
    >
      {signals.length === 0 ? (
        <div className="flex flex-col gap-1">
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="h-2 w-2 rounded-full bg-emerald-500/70" />
            Nothing crossed a threshold this window.
          </p>
          {notableTotal && notableTotal.baseline_daily_cost_usd > 0 && (
            <p className="pl-4 text-xs text-muted-foreground">
              Spend pace {formatCurrency(notableTotal.current_daily_cost_usd)}/day vs a 28-day
              average of {formatCurrency(notableTotal.baseline_daily_cost_usd)}/day.
            </p>
          )}
        </div>
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

function CostMovers({
  rows,
  labelFor,
}: {
  rows: AgentNotableChangeRow[];
  labelFor: (value: string) => string;
}) {
  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Spend movers by repo
      </h3>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No repo-level spend to compare across periods.
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border/60 text-left text-xs text-muted-foreground">
              <th className="pb-1.5 font-medium">Repo</th>
              <th className="pb-1.5 text-right font-medium">Cost</th>
              <th className="pb-1.5 text-right font-medium">Prior</th>
              <th className="pb-1.5 text-right font-medium">Δ Cost</th>
              <th className="pb-1.5 text-right font-medium">Δ Tokens gen.</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.group_value} className="border-b border-border/40">
                <td className="max-w-[16rem] truncate py-1.5 font-medium text-foreground">
                  {labelFor(row.group_value)}
                </td>
                <td className="py-1.5 text-right font-mono tabular-nums text-muted-foreground">
                  {formatCurrency(row.current_cost_usd)}
                </td>
                <td className="py-1.5 text-right font-mono tabular-nums text-muted-foreground">
                  {formatCurrency(row.prior_cost_usd)}
                </td>
                <CostDeltaCell value={row.cost_delta_usd} />
                <DeltaCell value={row.generated_tokens_delta} />
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
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

/** Cost up = red (more spend is the thing to notice); down = muted green. */
function CostDeltaCell({ value }: { value: number }) {
  const accent =
    value === 0 ? 'text-muted-foreground' : value > 0 ? 'text-red-400' : 'text-emerald-500';
  return (
    <td className={cn('py-1.5 text-right font-mono tabular-nums', accent)}>
      {value > 0 ? '+' : value < 0 ? '-' : ''}
      {formatCurrency(Math.abs(value))}
    </td>
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
