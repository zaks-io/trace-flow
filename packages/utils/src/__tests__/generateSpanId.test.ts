import { describe, it, expect } from 'vitest';
import { generateSpanId } from '../index';

describe('generateSpanId', () => {
  it('should generate a 16-character hex string', () => {
    const spanId = generateSpanId();
    expect(spanId).toHaveLength(16);
    expect(spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('should generate unique span IDs', () => {
    const spanId1 = generateSpanId();
    const spanId2 = generateSpanId();
    const spanId3 = generateSpanId();

    expect(spanId1).not.toBe(spanId2);
    expect(spanId2).not.toBe(spanId3);
    expect(spanId1).not.toBe(spanId3);
  });

  it('should only contain valid hexadecimal characters', () => {
    const spanId = generateSpanId();
    const hexRegex = /^[0-9a-f]+$/;
    expect(spanId).toMatch(hexRegex);
  });

  it('should pad bytes with leading zeros', () => {
    const spanIds = Array.from({ length: 100 }, () => generateSpanId());
    spanIds.forEach((spanId) => {
      expect(spanId).toHaveLength(16);
    });
  });
});
