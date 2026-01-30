import { describe, it, expect } from 'vitest';
import { computePeriod } from '../index';

describe('computePeriod', () => {
  it('returns correct period for mid-month date', () => {
    const result = computePeriod(new Date('2025-01-15T12:30:00Z'));
    expect(result.periodStart).toBe(Date.UTC(2025, 0, 1));
    expect(result.periodEnd).toBe(Date.UTC(2025, 1, 1));
  });

  it('returns correct period for first of month', () => {
    const result = computePeriod(new Date('2025-01-01T00:00:00Z'));
    expect(result.periodStart).toBe(Date.UTC(2025, 0, 1));
    expect(result.periodEnd).toBe(Date.UTC(2025, 1, 1));
  });

  it('returns correct period for last day of month', () => {
    const result = computePeriod(new Date('2025-01-31T23:59:59Z'));
    expect(result.periodStart).toBe(Date.UTC(2025, 0, 1));
    expect(result.periodEnd).toBe(Date.UTC(2025, 1, 1));
  });

  it('handles December to January year boundary', () => {
    const result = computePeriod(new Date('2025-12-25T00:00:00Z'));
    expect(result.periodStart).toBe(Date.UTC(2025, 11, 1));
    expect(result.periodEnd).toBe(Date.UTC(2026, 0, 1));
  });

  it('handles leap year February', () => {
    const result = computePeriod(new Date('2024-02-29T00:00:00Z'));
    expect(result.periodStart).toBe(Date.UTC(2024, 1, 1));
    expect(result.periodEnd).toBe(Date.UTC(2024, 2, 1));
  });

  it('returns timestamps at UTC midnight', () => {
    const result = computePeriod(new Date('2025-06-15T14:30:00Z'));
    const start = new Date(result.periodStart);
    const end = new Date(result.periodEnd);

    expect(start.getUTCHours()).toBe(0);
    expect(start.getUTCMinutes()).toBe(0);
    expect(start.getUTCSeconds()).toBe(0);
    expect(start.getUTCMilliseconds()).toBe(0);

    expect(end.getUTCHours()).toBe(0);
    expect(end.getUTCMinutes()).toBe(0);
    expect(end.getUTCSeconds()).toBe(0);
    expect(end.getUTCMilliseconds()).toBe(0);
  });
});
