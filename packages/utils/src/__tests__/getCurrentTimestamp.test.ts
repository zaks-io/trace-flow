import { describe, it, expect } from 'vitest';
import { getCurrentTimestamp } from '../index';

describe('getCurrentTimestamp', () => {
  it('should return a number', () => {
    const timestamp = getCurrentTimestamp();
    expect(typeof timestamp).toBe('number');
  });

  it('should return a timestamp in milliseconds', () => {
    const timestamp = getCurrentTimestamp();
    const currentYear = new Date().getFullYear();
    const timestampYear = new Date(timestamp).getFullYear();
    expect(timestampYear).toBe(currentYear);
  });

  it('should return a positive integer', () => {
    const timestamp = getCurrentTimestamp();
    expect(timestamp).toBeGreaterThan(0);
    expect(Number.isInteger(timestamp)).toBe(true);
  });
});
