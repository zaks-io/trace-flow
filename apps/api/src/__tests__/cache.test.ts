import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildCacheKey, computeTTL, hashString } from '../cache';

describe('hashString', () => {
  it('should return a 16-char hex string', async () => {
    const result = await hashString('test-input');
    expect(result).toMatch(/^[0-9a-f]{16}$/);
  });

  it('should return deterministic results', async () => {
    const a = await hashString('same-input');
    const b = await hashString('same-input');
    expect(a).toBe(b);
  });

  it('should return different hashes for different inputs', async () => {
    const a = await hashString('input-a');
    const b = await hashString('input-b');
    expect(a).not.toBe(b);
  });
});

describe('buildCacheKey', () => {
  it('should build a deterministic cache key', () => {
    const params = new URLSearchParams({ start: '100', end: '200' });
    const key = buildCacheKey('traces_list', 'abc123', 7, params);
    expect(key).toBe('cache:v1:traces_list:abc123:7:end=200&start=100');
  });

  it('should sort params alphabetically', () => {
    const params = new URLSearchParams({ z: '1', a: '2', m: '3' });
    const key = buildCacheKey('pipe', 'hash', 30, params);
    expect(key).toBe('cache:v1:pipe:hash:30:a=2&m=3&z=1');
  });

  it('should exclude token param', () => {
    const params = new URLSearchParams({ token: 'secret', a: '1' });
    const key = buildCacheKey('pipe', 'hash', 7, params);
    expect(key).toBe('cache:v1:pipe:hash:7:a=1');
  });

  it('should handle empty params', () => {
    const params = new URLSearchParams();
    const key = buildCacheKey('pipe', 'hash', 7, params);
    expect(key).toBe('cache:v1:pipe:hash:7:');
  });
});

describe('computeTTL', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return 0 for live polling queries', () => {
    const params = new URLSearchParams({ after_received_at: '12345' });
    expect(computeTTL('traces_list', params)).toBe(0);
  });

  it('should return 120 for filter_options pipe', () => {
    const params = new URLSearchParams();
    expect(computeTTL('filter_options', params)).toBe(120);
  });

  it('should return 30 for recent data queries', () => {
    const nowNs = String(Date.now() * 1_000_000);
    const params = new URLSearchParams({ end_time_ns: nowNs });
    expect(computeTTL('traces_list', params)).toBe(30);
  });

  it('should return 300 for historical queries', () => {
    const oldNs = String((Date.now() - 10 * 60 * 1000) * 1_000_000);
    const params = new URLSearchParams({ end_time_ns: oldNs });
    expect(computeTTL('traces_list', params)).toBe(300);
  });

  it('should return 300 when no end_time_ns is present', () => {
    const params = new URLSearchParams({ some_param: 'value' });
    expect(computeTTL('traces_list', params)).toBe(300);
  });

  it('should bypass cache for filter_options with after_received_at', () => {
    const params = new URLSearchParams({ after_received_at: '12345' });
    expect(computeTTL('filter_options', params)).toBe(0);
  });

  it('should return 300 for non-numeric end_time_ns', () => {
    const params = new URLSearchParams({ end_time_ns: 'not-a-number' });
    expect(computeTTL('traces_list', params)).toBe(300);
  });
});
