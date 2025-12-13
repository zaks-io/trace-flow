import { describe, it, expect } from 'vitest';
import { escapeSQL, formatNumber, jsonReplacer, buildApiKeyFilter, stripNulls } from '../utils';

describe('escapeSQL', () => {
  it('returns empty string unchanged', () => {
    expect(escapeSQL('')).toBe('');
  });

  it('returns string without quotes unchanged', () => {
    expect(escapeSQL('hello world')).toBe('hello world');
  });

  it('escapes single quote', () => {
    expect(escapeSQL("it's")).toBe("it''s");
  });

  it('escapes multiple quotes', () => {
    expect(escapeSQL("it's a test's")).toBe("it''s a test''s");
  });

  it('handles already escaped quotes', () => {
    expect(escapeSQL("it''s")).toBe("it''''s");
  });
});

describe('formatNumber', () => {
  it('returns 0 unchanged', () => {
    expect(formatNumber(0)).toBe(0);
  });

  it('returns integers unchanged', () => {
    expect(formatNumber(42)).toBe(42);
    expect(formatNumber(-100)).toBe(-100);
  });

  it('rounds to 6 decimal places', () => {
    expect(formatNumber(1.123456789)).toBe(1.123457);
    expect(formatNumber(0.0000001234)).toBe(0.0);
  });

  it('preserves numbers with fewer decimals', () => {
    expect(formatNumber(1.5)).toBe(1.5);
    expect(formatNumber(0.123)).toBe(0.123);
  });

  it('returns Infinity unchanged', () => {
    expect(formatNumber(Infinity)).toBe(Infinity);
    expect(formatNumber(-Infinity)).toBe(-Infinity);
  });

  it('returns NaN unchanged', () => {
    expect(formatNumber(NaN)).toBeNaN();
  });
});

describe('jsonReplacer', () => {
  it('formats numbers', () => {
    expect(jsonReplacer('key', 1.123456789)).toBe(1.123457);
  });

  it('passes through strings', () => {
    expect(jsonReplacer('key', 'hello')).toBe('hello');
  });

  it('passes through null', () => {
    expect(jsonReplacer('key', null)).toBe(null);
  });

  it('passes through undefined', () => {
    expect(jsonReplacer('key', undefined)).toBe(undefined);
  });

  it('passes through objects', () => {
    const obj = { a: 1 };
    expect(jsonReplacer('key', obj)).toBe(obj);
  });

  it('passes through arrays', () => {
    const arr = [1, 2, 3];
    expect(jsonReplacer('key', arr)).toBe(arr);
  });

  it('works with JSON.stringify', () => {
    const obj = { cost: 0.0000012345678, name: 'test' };
    const result = JSON.parse(JSON.stringify(obj, jsonReplacer));
    expect(result.cost).toBe(0.000001);
    expect(result.name).toBe('test');
  });
});

describe('buildApiKeyFilter', () => {
  it('returns empty string for empty array', () => {
    expect(buildApiKeyFilter([])).toBe('');
  });

  it('builds filter for single key', () => {
    expect(buildApiKeyFilter(['key1'])).toBe("ApiKey IN ('key1')");
  });

  it('builds filter for multiple keys', () => {
    expect(buildApiKeyFilter(['key1', 'key2', 'key3'])).toBe("ApiKey IN ('key1', 'key2', 'key3')");
  });

  it('escapes special characters in keys', () => {
    expect(buildApiKeyFilter(["key'with'quotes"])).toBe("ApiKey IN ('key''with''quotes')");
  });
});

describe('stripNulls', () => {
  it('returns undefined for null', () => {
    expect(stripNulls(null)).toBeUndefined();
  });

  it('returns undefined for undefined', () => {
    expect(stripNulls(undefined)).toBeUndefined();
  });

  it('returns primitive values unchanged', () => {
    expect(stripNulls('hello')).toBe('hello');
    expect(stripNulls(42)).toBe(42);
    expect(stripNulls(true)).toBe(true);
  });

  it('strips null values from objects', () => {
    expect(stripNulls({ a: 1, b: null, c: 'test' })).toEqual({ a: 1, c: 'test' });
  });

  it('strips undefined values from objects', () => {
    expect(stripNulls({ a: 1, b: undefined, c: 'test' })).toEqual({ a: 1, c: 'test' });
  });

  it('returns undefined for empty object after stripping', () => {
    expect(stripNulls({ a: null, b: undefined })).toBeUndefined();
  });

  it('filters null/undefined from arrays', () => {
    expect(stripNulls([1, null, 2, undefined, 3])).toEqual([1, 2, 3]);
  });

  it('returns undefined for empty array after filtering', () => {
    expect(stripNulls([null, undefined])).toBeUndefined();
  });

  it('handles nested objects', () => {
    const input = {
      a: 1,
      b: {
        c: null,
        d: 'test',
        e: {
          f: undefined,
          g: 42,
        },
      },
    };
    expect(stripNulls(input)).toEqual({
      a: 1,
      b: {
        d: 'test',
        e: {
          g: 42,
        },
      },
    });
  });

  it('handles nested arrays', () => {
    const input = {
      items: [{ a: 1, b: null }, null, { c: 2 }],
    };
    expect(stripNulls(input)).toEqual({
      items: [{ a: 1 }, { c: 2 }],
    });
  });

  it('removes nested object if all values are null', () => {
    const input = {
      a: 1,
      b: {
        c: null,
        d: undefined,
      },
    };
    expect(stripNulls(input)).toEqual({ a: 1 });
  });
});
