import { describe, expect, it } from 'vitest';
import { isSafeHttpUrl } from '../AnalystMessagePartView';

describe('isSafeHttpUrl', () => {
  it('allows http and https URLs', () => {
    expect(isSafeHttpUrl('http://example.com/file.csv')).toBe(true);
    expect(isSafeHttpUrl('https://example.com/file.csv')).toBe(true);
  });

  it('rejects javascript: and other script-bearing schemes', () => {
    expect(isSafeHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeHttpUrl('JavaScript:alert(1)')).toBe(false);
    expect(isSafeHttpUrl('vbscript:msgbox(1)')).toBe(false);
  });

  it('rejects data: and blob: URLs', () => {
    expect(isSafeHttpUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isSafeHttpUrl('blob:https://example.com/uuid')).toBe(false);
  });

  it('rejects malformed or empty input', () => {
    expect(isSafeHttpUrl('')).toBe(false);
    expect(isSafeHttpUrl('not a url')).toBe(false);
    expect(isSafeHttpUrl('//example.com/file.csv')).toBe(false);
  });
});
