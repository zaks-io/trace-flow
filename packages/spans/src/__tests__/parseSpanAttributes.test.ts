import { describe, expect, it } from 'vitest';
import { parseSpanAttributes } from '../parseSpanAttributes';

describe('parseSpanAttributes', () => {
  it('parses a valid JSON string', () => {
    const result = parseSpanAttributes('{"gen_ai.system":"openai","gen_ai.request.model":"gpt-4"}');
    expect(result).toEqual({
      'gen_ai.system': 'openai',
      'gen_ai.request.model': 'gpt-4',
    });
  });

  it('returns the object as-is when passed an already-parsed record', () => {
    const attrs = { 'gen_ai.system': 'anthropic' };
    expect(parseSpanAttributes(attrs)).toBe(attrs);
  });

  it('returns empty object for invalid JSON', () => {
    expect(parseSpanAttributes('not json')).toEqual({});
  });

  it('returns empty object for empty string', () => {
    expect(parseSpanAttributes('')).toEqual({});
  });
});
