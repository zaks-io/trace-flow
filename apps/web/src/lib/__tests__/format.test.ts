import { describe, it, expect } from 'vitest';
import { formatNumber, formatCurrency, parseTinybirdDate } from '../format';

describe('formatNumber', () => {
  it('abbreviates with K/M/B/T suffixes', () => {
    expect(formatNumber(72_500)).toBe('72.5K');
    expect(formatNumber(9_127_900_000)).toBe('9.1B');
    expect(formatNumber(8_014_100_000)).toBe('8.0B');
    expect(formatNumber(1_500_000_000_000)).toBe('1.5T');
  });

  it('leaves sub-thousand values unabbreviated', () => {
    expect(formatNumber(0)).toBe('0');
    expect(formatNumber(999)).toBe('999');
  });

  it('handles negatives by reapplying the sign', () => {
    expect(formatNumber(-43_500_000)).toBe('-43.5M');
  });

  it('promotes to the next unit instead of rounding to 1000.0', () => {
    expect(formatNumber(999_950)).toBe('1.0M');
    expect(formatNumber(999_950_000)).toBe('1.0B');
    expect(formatNumber(999_950_000_000)).toBe('1.0T');
  });
});

describe('formatCurrency', () => {
  it('returns a dash for null/NaN', () => {
    expect(formatCurrency(null)).toBe('-');
    expect(formatCurrency(NaN)).toBe('-');
  });

  it('keeps high precision for tiny values', () => {
    expect(formatCurrency(0.001)).toBe('$0.0010');
    expect(formatCurrency(0.5)).toBe('$0.500');
  });

  it('keeps full cents in the normal range', () => {
    expect(formatCurrency(123.45)).toBe('$123.45');
  });

  it('abbreviates at scale', () => {
    expect(formatCurrency(6846.96)).toBe('$6.8K');
    expect(formatCurrency(1_234_567)).toBe('$1.2M');
  });

  it('handles negatives by reapplying the sign', () => {
    expect(formatCurrency(-6846.96)).toBe('-$6.8K');
  });

  it('promotes to the next unit instead of rounding to 1000.0', () => {
    expect(formatCurrency(999_950)).toBe('$1.0M');
    expect(formatCurrency(999_950_000)).toBe('$1.0B');
  });
});

describe('parseTinybirdDate', () => {
  // Assert on the absolute epoch, so the result is independent of the runner's local TZ.
  const may30at1amUtc = Date.UTC(2025, 4, 30, 1, 0, 0);

  it('reads a space-separated ClickHouse DateTime as UTC, not local', () => {
    expect(parseTinybirdDate('2025-05-30 01:00:00').getTime()).toBe(may30at1amUtc);
  });

  it('handles the DateTime64 millisecond form', () => {
    expect(parseTinybirdDate('2025-05-30 01:00:00.000').getTime()).toBe(may30at1amUtc);
  });

  it('passes through values that already carry a zone', () => {
    expect(parseTinybirdDate('2025-05-30T01:00:00Z').getTime()).toBe(may30at1amUtc);
    expect(parseTinybirdDate('2025-05-30T01:00:00+00:00').getTime()).toBe(may30at1amUtc);
  });

  it('passes through epoch-millisecond numbers', () => {
    expect(parseTinybirdDate(may30at1amUtc).getTime()).toBe(may30at1amUtc);
  });

  it('returns an invalid Date for garbage, leaving callers to fall back', () => {
    expect(Number.isNaN(parseTinybirdDate('not a date').getTime())).toBe(true);
  });
});
