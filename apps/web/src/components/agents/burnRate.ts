import { parseTinybirdDate } from '@/lib/format';
import type { AgentSummaryRow, AgentTimeseriesRow } from './types';

const THIRTY_DAYS = 30;

interface DayTotals {
  costUsd: number;
  tokens: number;
  messages: number;
  sessions: number;
  isWeekday: boolean;
}

export interface BurnRateStats {
  calendarDays: number;
  activeDays: number;
  quietDays: number;
  weekdayActiveDays: number;
  costPerCalendarDay: number;
  costPerActiveDay: number;
  costPerWeekdayActiveDay: number;
  tokensPerActiveDay: number;
  messagesPerActiveDay: number;
  sessionsPerActiveDay: number;
  priorCostPerCalendarDay: number;
  priorCostPerActiveDay: number;
  priorTokensPerActiveDay: number;
  costPerActiveDayDeltaPct: number | null;
  tokenPerActiveDayDeltaPct: number | null;
  projectedThirtyDayCost: number;
  priorProjectedThirtyDayCost: number;
}

function makeDayFormatter(timeZone: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  }
}

function dayKey(bucketStart: string, formatter: Intl.DateTimeFormat): string {
  const date = parseTinybirdDate(bucketStart);
  if (Number.isNaN(date.getTime())) return bucketStart.slice(0, 10);

  const parts = formatter.formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  if (!year || !month || !day) return bucketStart.slice(0, 10);
  return `${year}-${month}-${day}`;
}

function isWeekdayKey(key: string): boolean {
  const weekday = new Date(`${key}T12:00:00Z`).getUTCDay();
  return weekday >= 1 && weekday <= 5;
}

function isActive(day: DayTotals): boolean {
  return day.costUsd > 0 || day.tokens > 0 || day.messages > 0 || day.sessions > 0;
}

function aggregateDays(rows: AgentTimeseriesRow[], timezone: string): DayTotals[] {
  const days = new Map<string, DayTotals>();
  const formatter = makeDayFormatter(timezone);

  for (const row of rows) {
    const key = dayKey(row.bucket_start, formatter);
    const existing =
      days.get(key) ??
      ({
        costUsd: 0,
        tokens: 0,
        messages: 0,
        sessions: 0,
        isWeekday: isWeekdayKey(key),
      } satisfies DayTotals);

    existing.costUsd += row.cost_usd;
    existing.tokens += row.total_tokens;
    existing.messages += row.message_count;
    existing.sessions += row.session_count;
    days.set(key, existing);
  }

  return [...days.values()];
}

/**
 * Count the local calendar days the [start, end) window touches, keyed the same way as
 * `aggregateDays`. The timeseries buckets are UTC-aligned, so a viewer behind UTC sees the
 * first bucket land on the previous local day — counting active days in local time against a
 * UTC `(end - start) / day` span produced "32 of 31 in range". Both must count local days.
 */
function calendarDaysInWindow(startMs: number, endMs: number, timezone: string): number {
  if (!(endMs > startMs)) return 1;
  const formatter = makeDayFormatter(timezone);
  const keys = new Set<string>();
  // Walk the window in 1h steps so DST-shortened/lengthened days still resolve to one key each.
  for (let t = startMs; t < endMs; t += 60 * 60 * 1000) {
    keys.add(dayKey(new Date(t).toISOString(), formatter));
  }
  keys.add(dayKey(new Date(endMs - 1).toISOString(), formatter));
  return Math.max(1, keys.size);
}

function rate(total: number, days: number): number {
  return days > 0 ? total / days : 0;
}

function deltaPct(current: number, prior: number): number | null {
  if (prior <= 0) return current > 0 ? null : 0;
  return (current - prior) / prior;
}

export function buildPriorWindowParams(
  filterParams: Record<string, string | number>,
): Record<string, string | number> {
  const start = Number(filterParams.start_time_ms ?? 0);
  const end = Number(filterParams.end_time_ms ?? 0);
  const span = Math.max(0, end - start);
  return {
    ...filterParams,
    start_time_ms: start - span,
    end_time_ms: start,
  };
}

export function hasUsableBurnRateBuckets(rows: AgentTimeseriesRow[], timezone = 'UTC'): boolean {
  return aggregateDays(rows, timezone).some(isActive);
}

export function buildBurnRateStats({
  summary,
  currentRows,
  priorRows,
  filterParams,
  timezone = 'UTC',
}: {
  summary: AgentSummaryRow;
  currentRows: AgentTimeseriesRow[];
  priorRows: AgentTimeseriesRow[];
  filterParams: Record<string, string | number>;
  timezone?: string;
}): BurnRateStats {
  const start = Number(filterParams.start_time_ms ?? 0);
  const end = Number(filterParams.end_time_ms ?? start);
  const calendarDays = calendarDaysInWindow(start, end, timezone);

  const currentDays = aggregateDays(currentRows, timezone);
  const priorDays = aggregateDays(priorRows, timezone);
  const activeCurrentDays = currentDays.filter(isActive);
  const weekdayActiveCurrentDays = activeCurrentDays.filter((day) => day.isWeekday);
  const activeDays = activeCurrentDays.length;
  const priorActiveDays = priorDays.filter(isActive).length;
  const weekdayActiveDays = weekdayActiveCurrentDays.length;
  const weekdayCostUsd = weekdayActiveCurrentDays.reduce((total, day) => total + day.costUsd, 0);

  const costPerCalendarDay = rate(summary.estimated_cost_usd, calendarDays);
  const costPerActiveDay = rate(summary.estimated_cost_usd, activeDays);
  const priorCostPerCalendarDay = rate(summary.prior_cost_usd, calendarDays);
  const priorCostPerActiveDay = rate(summary.prior_cost_usd, priorActiveDays);
  const tokensPerActiveDay = rate(summary.total_tokens, activeDays);
  const priorTokensPerActiveDay = rate(summary.prior_total_tokens, priorActiveDays);

  return {
    calendarDays,
    activeDays,
    quietDays: Math.max(0, Math.round(calendarDays) - activeDays),
    weekdayActiveDays,
    costPerCalendarDay,
    costPerActiveDay,
    costPerWeekdayActiveDay: rate(weekdayCostUsd, weekdayActiveDays),
    tokensPerActiveDay,
    messagesPerActiveDay: rate(summary.message_count, activeDays),
    sessionsPerActiveDay: rate(summary.session_count, activeDays),
    priorCostPerCalendarDay,
    priorCostPerActiveDay,
    priorTokensPerActiveDay,
    costPerActiveDayDeltaPct: deltaPct(costPerActiveDay, priorCostPerActiveDay),
    tokenPerActiveDayDeltaPct: deltaPct(tokensPerActiveDay, priorTokensPerActiveDay),
    projectedThirtyDayCost: costPerCalendarDay * THIRTY_DAYS,
    priorProjectedThirtyDayCost: priorCostPerCalendarDay * THIRTY_DAYS,
  };
}
