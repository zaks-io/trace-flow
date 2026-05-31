import { describe, it, expect } from 'vitest';
import {
  TRACE_ID_PATTERN,
  buildTimeRangeNs,
  noApiKeysError,
  invalidTraceIdError,
  traceNotFoundError,
  jsonReplacer,
  stripNulls,
  splitPatterns,
} from '../tools/shared';

describe('buildTimeRangeNs', () => {
  it('floors fractional hours before converting to bigint', () => {
    const result = buildTimeRangeNs(1.5);
    expect(result.hours).toBe(1);
  });

  it('clamps non-positive hours to one hour', () => {
    const result = buildTimeRangeNs(0);
    expect(result.hours).toBe(1);
  });
});

describe('TRACE_ID_PATTERN', () => {
  it('matches valid 32-character lowercase hex string', () => {
    expect(TRACE_ID_PATTERN.test('abcdef0123456789abcdef0123456789')).toBe(true);
  });

  it('matches valid 32-character uppercase hex string', () => {
    expect(TRACE_ID_PATTERN.test('ABCDEF0123456789ABCDEF0123456789')).toBe(true);
  });

  it('matches valid 32-character mixed case hex string', () => {
    expect(TRACE_ID_PATTERN.test('AbCdEf0123456789aBcDeF0123456789')).toBe(true);
  });

  it('rejects string shorter than 32 characters', () => {
    expect(TRACE_ID_PATTERN.test('abcdef0123456789')).toBe(false);
  });

  it('rejects string longer than 32 characters', () => {
    expect(TRACE_ID_PATTERN.test('abcdef0123456789abcdef0123456789extra')).toBe(false);
  });

  it('rejects non-hex characters', () => {
    expect(TRACE_ID_PATTERN.test('ghijkl0123456789ghijkl0123456789')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(TRACE_ID_PATTERN.test('')).toBe(false);
  });
});

describe('noApiKeysError', () => {
  it('returns error with isError true', () => {
    const result = noApiKeysError();
    expect(result.isError).toBe(true);
  });

  it('returns text content about no API keys', () => {
    const result = noApiKeysError();
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe('text');
    expect(result.content[0]!.text).toContain('No API keys');
  });
});

describe('invalidTraceIdError', () => {
  it('returns error with isError true', () => {
    const result = invalidTraceIdError();
    expect(result.isError).toBe(true);
  });

  it('returns text content about invalid trace ID', () => {
    const result = invalidTraceIdError();
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe('text');
    expect(result.content[0]!.text).toContain('Invalid trace ID');
    expect(result.content[0]!.text).toContain('32-character hex');
  });
});

describe('traceNotFoundError', () => {
  it('returns error with isError true', () => {
    const result = traceNotFoundError('abc123');
    expect(result.isError).toBe(true);
  });

  it('includes trace ID in error message', () => {
    const traceId = 'abcdef0123456789abcdef0123456789';
    const result = traceNotFoundError(traceId);
    expect(result.content[0]!.text).toContain(traceId);
  });

  it('returns text content about trace not found', () => {
    const result = traceNotFoundError('test123');
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe('text');
    expect(result.content[0]!.text).toContain('Trace not found');
  });
});

describe('jsonReplacer', () => {
  it('rounds floating point numbers', () => {
    const result = jsonReplacer('key', 0.123456789);
    expect(result).toBe(0.123457);
  });

  it('leaves integers unchanged', () => {
    const result = jsonReplacer('key', 42);
    expect(result).toBe(42);
  });

  it('leaves zero unchanged', () => {
    const result = jsonReplacer('key', 0);
    expect(result).toBe(0);
  });

  it('leaves strings unchanged', () => {
    const result = jsonReplacer('key', 'test');
    expect(result).toBe('test');
  });

  it('leaves objects unchanged', () => {
    const obj = { nested: 'value' };
    const result = jsonReplacer('key', obj);
    expect(result).toBe(obj);
  });

  it('leaves arrays unchanged', () => {
    const arr = [1, 2, 3];
    const result = jsonReplacer('key', arr);
    expect(result).toBe(arr);
  });
});

describe('stripNulls', () => {
  it('returns undefined for null', () => {
    const result = stripNulls(null);
    expect(result).toBeUndefined();
  });

  it('returns undefined for undefined', () => {
    const result = stripNulls(undefined);
    expect(result).toBeUndefined();
  });

  it('returns primitive values as-is', () => {
    expect(stripNulls('test')).toBe('test');
    expect(stripNulls(42)).toBe(42);
    expect(stripNulls(true)).toBe(true);
  });

  it('removes null values from objects', () => {
    const result = stripNulls({ a: 1, b: null, c: 'test' });
    expect(result).toEqual({ a: 1, c: 'test' });
  });

  it('removes undefined values from objects', () => {
    const result = stripNulls({ a: 1, b: undefined, c: 'test' });
    expect(result).toEqual({ a: 1, c: 'test' });
  });

  it('recursively strips nested objects', () => {
    const result = stripNulls({
      a: 1,
      nested: { x: null, y: 2 },
    });
    expect(result).toEqual({ a: 1, nested: { y: 2 } });
  });

  it('filters null values from arrays', () => {
    const result = stripNulls([1, null, 2, undefined, 3]);
    expect(result).toEqual([1, 2, 3]);
  });

  it('returns undefined for empty object after stripping', () => {
    const result = stripNulls({ a: null, b: undefined });
    expect(result).toBeUndefined();
  });

  it('returns empty array after stripping all null/undefined elements', () => {
    const result = stripNulls([null, undefined]);
    expect(result).toEqual([]);
  });
});

describe('splitPatterns', () => {
  it('separates exact patterns from wildcard prefixes', () => {
    const result = splitPatterns(['gen_ai.request', 'http.*', 'db.query']);
    expect(result.exact).toEqual(['gen_ai.request', 'db.query']);
    expect(result.prefixes).toEqual(['http.']);
  });

  it('handles patterns ending with .*', () => {
    const result = splitPatterns(['gen_ai.*', 'gen_ai.*']);
    expect(result.exact).toEqual([]);
    expect(result.prefixes).toEqual(['gen_ai.', 'gen_ai.']);
  });

  it('returns empty arrays for empty input', () => {
    const result = splitPatterns([]);
    expect(result.exact).toEqual([]);
    expect(result.prefixes).toEqual([]);
  });

  it('handles all exact patterns', () => {
    const result = splitPatterns(['gen_ai.request', 'gen_ai.response', 'http.request']);
    expect(result.exact).toEqual(['gen_ai.request', 'gen_ai.response', 'http.request']);
    expect(result.prefixes).toEqual([]);
  });

  it('handles single wildcard pattern', () => {
    const result = splitPatterns(['gen_ai.*']);
    expect(result.exact).toEqual([]);
    expect(result.prefixes).toEqual(['gen_ai.']);
  });

  it('supports trailing star prefixes for root span names', () => {
    const result = splitPatterns(['chat *', 'embeddings *', 'gen_ai.response.*']);
    expect(result.exact).toEqual([]);
    expect(result.prefixes).toEqual(['chat ', 'embeddings ', 'gen_ai.response.']);
  });
});
