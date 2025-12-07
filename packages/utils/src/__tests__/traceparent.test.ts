import { describe, it, expect } from 'vitest';
import { parseTraceparent, formatTraceparent, parseBaggage, formatBaggage } from '../index';

describe('parseTraceparent', () => {
  it('should parse valid traceparent header', () => {
    const header = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    const result = parseTraceparent(header);
    expect(result).toEqual({
      version: '00',
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      parentId: '00f067aa0ba902b7',
      flags: 1,
    });
  });

  it('should normalize uppercase to lowercase', () => {
    const header = '00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01';
    const result = parseTraceparent(header);
    expect(result?.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(result?.parentId).toBe('00f067aa0ba902b7');
  });

  it('should parse flags correctly', () => {
    expect(parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00')?.flags).toBe(
      0,
    );
    expect(parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')?.flags).toBe(
      1,
    );
    expect(parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-ff')?.flags).toBe(
      255,
    );
  });

  it('should return null for all-zero trace-id', () => {
    const header = '00-00000000000000000000000000000000-00f067aa0ba902b7-01';
    expect(parseTraceparent(header)).toBeNull();
  });

  it('should return null for all-zero parent-id', () => {
    const header = '00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01';
    expect(parseTraceparent(header)).toBeNull();
  });

  it('should return null for invalid format', () => {
    expect(parseTraceparent('invalid')).toBeNull();
    expect(parseTraceparent('00-abc-def-01')).toBeNull();
    expect(parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7')).toBeNull();
  });

  it('should return null for wrong trace-id length', () => {
    expect(parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e47-00f067aa0ba902b7-01')).toBeNull();
    expect(parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e47361-00f067aa0ba902b7-01')).toBeNull();
  });

  it('should return null for wrong parent-id length', () => {
    expect(parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b-01')).toBeNull();
    expect(parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b71-01')).toBeNull();
  });

  it('should return null for null', () => {
    expect(parseTraceparent(null)).toBeNull();
  });

  it('should return null for undefined', () => {
    expect(parseTraceparent(undefined)).toBeNull();
  });

  it('should return null for empty string', () => {
    expect(parseTraceparent('')).toBeNull();
  });
});

describe('formatTraceparent', () => {
  it('should format traceparent with default flags', () => {
    const result = formatTraceparent('4bf92f3577b34da6a3ce929d0e0e4736', '00f067aa0ba902b7');
    expect(result).toBe('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
  });

  it('should format traceparent with custom flags', () => {
    const result = formatTraceparent('4bf92f3577b34da6a3ce929d0e0e4736', '00f067aa0ba902b7', 0);
    expect(result).toBe('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00');
  });

  it('should normalize uppercase IDs to lowercase', () => {
    const result = formatTraceparent('4BF92F3577B34DA6A3CE929D0E0E4736', '00F067AA0BA902B7');
    expect(result).toBe('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
  });

  it('should round-trip with parseTraceparent', () => {
    const original = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    const parsed = parseTraceparent(original);
    const formatted = formatTraceparent(parsed!.traceId, parsed!.parentId, parsed!.flags);
    expect(formatted).toBe(original);
  });
});

describe('parseBaggage', () => {
  it('should parse single key-value pair', () => {
    expect(parseBaggage('key1=value1')).toEqual({ key1: 'value1' });
  });

  it('should parse multiple key-value pairs', () => {
    expect(parseBaggage('key1=value1,key2=value2')).toEqual({
      key1: 'value1',
      key2: 'value2',
    });
  });

  it('should handle whitespace', () => {
    expect(parseBaggage('key1=value1 , key2=value2')).toEqual({
      key1: 'value1',
      key2: 'value2',
    });
  });

  it('should decode percent-encoded values', () => {
    expect(parseBaggage('key=hello%20world')).toEqual({ key: 'hello world' });
    expect(parseBaggage('key=hello%2Cworld')).toEqual({ key: 'hello,world' });
  });

  it('should handle values containing equals sign', () => {
    expect(parseBaggage('key=value=with=equals')).toEqual({ key: 'value=with=equals' });
  });

  it('should skip entries without equals sign', () => {
    expect(parseBaggage('key1=value1,invalidentry,key2=value2')).toEqual({
      key1: 'value1',
      key2: 'value2',
    });
  });

  it('should return empty object for null', () => {
    expect(parseBaggage(null)).toEqual({});
  });

  it('should return empty object for undefined', () => {
    expect(parseBaggage(undefined)).toEqual({});
  });

  it('should return empty object for empty string', () => {
    expect(parseBaggage('')).toEqual({});
  });
});

describe('formatBaggage', () => {
  it('should format single entry', () => {
    expect(formatBaggage({ key1: 'value1' })).toBe('key1=value1');
  });

  it('should format multiple entries', () => {
    const result = formatBaggage({ key1: 'value1', key2: 'value2' });
    expect(result).toContain('key1=value1');
    expect(result).toContain('key2=value2');
    expect(result.split(',').length).toBe(2);
  });

  it('should percent-encode special characters', () => {
    expect(formatBaggage({ key: 'hello world' })).toBe('key=hello%20world');
    expect(formatBaggage({ key: 'hello,world' })).toBe('key=hello%2Cworld');
  });

  it('should return empty string for empty object', () => {
    expect(formatBaggage({})).toBe('');
  });

  it('should round-trip with parseBaggage', () => {
    const original = { session_id: 'abc123', user_id: 'user-456' };
    const formatted = formatBaggage(original);
    const parsed = parseBaggage(formatted);
    expect(parsed).toEqual(original);
  });
});
