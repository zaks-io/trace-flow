export const MAX_AGENT_ANALYTICS_DAY_BUCKETS = 367;

/** Tinybird facts expire with toIntervalYear(1); a leap-spanning year has 367 inclusive day buckets. */
export function agentAnalyticsDayBounds(now: number): {
  oldestDay: string;
  today: string;
  oldestDayStart: number;
  tomorrowStart: number;
} {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid analytics retention clock');
  const current = new Date(now);
  const midnight = new Date(
    Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate()),
  );
  const oldest = new Date(midnight);
  oldest.setUTCFullYear(oldest.getUTCFullYear() - 1);
  return {
    oldestDay: oldest.toISOString().slice(0, 10),
    today: midnight.toISOString().slice(0, 10),
    oldestDayStart: oldest.getTime(),
    tomorrowStart: midnight.getTime() + 86_400_000,
  };
}
