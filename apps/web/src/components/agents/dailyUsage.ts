import { parseTinybirdDate } from '@/lib/format';
import type { AgentTimeseriesRow } from './types';

interface DayPoint {
  label: string;
  tokens: number;
  cost: number;
}

/** Burn queries force granularity=day, so buckets are local midnight expressed in UTC.
 * The pipe's unchanged UTC daily rollups apply only to granularity=auto, never this series.
 */
export function buildDailyUsage(burnSeries: AgentTimeseriesRow[], timezone: string): DayPoint[] {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const byDay = new Map<string, DayPoint>();
  for (const row of burnSeries) {
    const label = formatter.format(parseTinybirdDate(row.bucket_start));
    const point = byDay.get(label) ?? { label, tokens: 0, cost: 0 };
    point.tokens += row.total_tokens;
    point.cost += row.cost_usd;
    byDay.set(label, point);
  }
  return [...byDay.values()].sort((a, b) => a.label.localeCompare(b.label));
}
