import { describe, it, expect } from 'vitest';
import { validateTraceId, validateSpanId } from '../index';

describe('validateTraceId', () => {
  it('should return valid 32-char hex trace ID', () => {
    const traceId = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4';
    expect(validateTraceId(traceId)).toBe(traceId);
  });

  it('should normalize uppercase to lowercase', () => {
    const traceId = 'A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4';
    expect(validateTraceId(traceId)).toBe(traceId.toLowerCase());
  });

  it('should return null for too short trace ID', () => {
    expect(validateTraceId('a1b2c3d4')).toBeNull();
  });

  it('should return null for too long trace ID', () => {
    expect(validateTraceId('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4extra')).toBeNull();
  });

  it('should return null for non-hex characters', () => {
    expect(validateTraceId('g1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4')).toBeNull();
  });

  it('should return null for trace ID with dashes', () => {
    expect(validateTraceId('a1b2c3d4-5f6a-1b2c-3d4e-5f6a1b2c3d4')).toBeNull();
  });

  it('should return null for null', () => {
    expect(validateTraceId(null)).toBeNull();
  });

  it('should return null for undefined', () => {
    expect(validateTraceId(undefined)).toBeNull();
  });

  it('should return null for empty string', () => {
    expect(validateTraceId('')).toBeNull();
  });
});

describe('validateSpanId', () => {
  it('should return valid 16-char hex span ID', () => {
    const spanId = 'a1b2c3d4e5f6a1b2';
    expect(validateSpanId(spanId)).toBe(spanId);
  });

  it('should normalize uppercase to lowercase', () => {
    const spanId = 'A1B2C3D4E5F6A1B2';
    expect(validateSpanId(spanId)).toBe(spanId.toLowerCase());
  });

  it('should return null for too short span ID', () => {
    expect(validateSpanId('a1b2c3d4')).toBeNull();
  });

  it('should return null for too long span ID', () => {
    expect(validateSpanId('a1b2c3d4e5f6a1b2extra')).toBeNull();
  });

  it('should return null for non-hex characters', () => {
    expect(validateSpanId('g1b2c3d4e5f6a1b2')).toBeNull();
  });

  it('should return null for null', () => {
    expect(validateSpanId(null)).toBeNull();
  });

  it('should return null for undefined', () => {
    expect(validateSpanId(undefined)).toBeNull();
  });

  it('should return null for empty string', () => {
    expect(validateSpanId('')).toBeNull();
  });
});
