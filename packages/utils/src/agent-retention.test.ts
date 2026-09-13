import { describe, expect, it } from 'vitest';
import { agentAnalyticsDayBounds, MAX_AGENT_ANALYTICS_DAY_BUCKETS } from './agent-retention';

describe('calendar-year analytics retention', () => {
  it.each([
    ['2026-09-13', '2025-09-13', 366],
    ['2024-09-13', '2023-09-13', 367],
    ['2025-02-28', '2024-02-28', 367],
    ['2024-02-29', '2023-03-01', 366],
  ])('preserves the calendar-year window at %s', (today, oldestDay, buckets) => {
    const bounds = agentAnalyticsDayBounds(Date.parse(`${today}T12:00:00.000Z`));
    expect(bounds.today).toBe(today);
    expect(bounds.oldestDay).toBe(oldestDay);
    expect((bounds.tomorrowStart - bounds.oldestDayStart) / 86_400_000).toBe(buckets);
    expect(buckets).toBeLessThanOrEqual(MAX_AGENT_ANALYTICS_DAY_BUCKETS);
  });
});
