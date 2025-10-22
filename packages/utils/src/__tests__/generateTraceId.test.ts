import { describe, it, expect } from 'vitest';
import { generateTraceId } from '../index';

describe('generateTraceId', () => {
  it('should generate a 32-character hex string', () => {
    const traceId = generateTraceId();
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(traceId.length).toBe(32);
  });

  it('should generate unique trace IDs', () => {
    const traceId1 = generateTraceId();
    const traceId2 = generateTraceId();
    const traceId3 = generateTraceId();

    expect(traceId1).not.toBe(traceId2);
    expect(traceId2).not.toBe(traceId3);
    expect(traceId1).not.toBe(traceId3);
  });

  it('should only contain lowercase hexadecimal characters', () => {
    const traceId = generateTraceId();
    expect(traceId).toMatch(/^[0-9a-f]+$/);
    expect(traceId.toUpperCase()).not.toBe(traceId);
  });

  it('should generate trace IDs with high entropy', () => {
    const traceIds = Array.from({ length: 100 }, () => generateTraceId());
    const uniqueTraceIds = new Set(traceIds);
    expect(uniqueTraceIds.size).toBe(100);
  });
});
