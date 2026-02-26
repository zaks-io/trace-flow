// tinybird.ts requires TINYBIRD_ADMIN_TOKEN and TINYBIRD_WORKSPACE_ID at module load time.
// These are provided via vitest.config.ts env configuration.
import { describe, it, expect } from 'vitest';
import { sanitizeApiKeys, UUID_PATTERN } from '../tinybird';

describe('tinybird API key sanitization', () => {
  describe('UUID_PATTERN', () => {
    it('matches standard lowercase UUID', () => {
      expect(UUID_PATTERN.test('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    });

    it('matches UUID with uppercase hex', () => {
      expect(UUID_PATTERN.test('550E8400-E29B-41D4-A716-446655440000')).toBe(true);
    });

    it('matches crypto.randomUUID() output format', () => {
      // All API keys in this system are generated via crypto.randomUUID()
      const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
      expect(UUID_PATTERN.test(uuid)).toBe(true);
    });

    it('rejects empty string', () => {
      expect(UUID_PATTERN.test('')).toBe(false);
    });

    it('rejects key with SQL injection payload', () => {
      expect(UUID_PATTERN.test("key'; DROP TABLE--")).toBe(false);
    });

    it('rejects key with comma injection', () => {
      // Comma injection could add extra values to the IN clause
      expect(UUID_PATTERN.test('valid-uuid,malicious-key')).toBe(false);
    });

    it('rejects key with single quote', () => {
      expect(UUID_PATTERN.test("a1b2c3d4-e5f6-7890-abcd-ef123456789'")).toBe(false);
    });

    it('rejects UUID missing dashes', () => {
      expect(UUID_PATTERN.test('550e8400e29b41d4a716446655440000')).toBe(false);
    });

    it('rejects UUID with wrong segment lengths', () => {
      expect(UUID_PATTERN.test('550e840-e29b-41d4-a716-446655440000')).toBe(false);
    });

    it('rejects UUID with extra characters', () => {
      expect(UUID_PATTERN.test('550e8400-e29b-41d4-a716-446655440000-extra')).toBe(false);
    });

    it('rejects non-hex characters in UUID', () => {
      expect(UUID_PATTERN.test('gggggggg-e29b-41d4-a716-446655440000')).toBe(false);
    });
  });

  describe('sanitizeApiKeys', () => {
    it('passes through valid UUIDs unchanged', () => {
      const keys = ['550e8400-e29b-41d4-a716-446655440000', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'];
      expect(sanitizeApiKeys(keys)).toEqual(keys);
    });

    it('filters out non-UUID keys', () => {
      const keys = [
        '550e8400-e29b-41d4-a716-446655440000',
        "malicious'; DROP TABLE--",
        'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      ];
      expect(sanitizeApiKeys(keys)).toEqual([
        '550e8400-e29b-41d4-a716-446655440000',
        'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      ]);
    });

    it('returns empty array for empty input', () => {
      expect(sanitizeApiKeys([])).toEqual([]);
    });

    it('returns empty array when all keys are invalid', () => {
      expect(sanitizeApiKeys(['not-a-uuid', 'also-not', "'; DROP TABLE--"])).toEqual([]);
    });

    it('handles mixed-case UUIDs (case-insensitive match)', () => {
      const keys = ['550E8400-E29B-41D4-A716-446655440000'];
      expect(sanitizeApiKeys(keys)).toEqual(keys);
    });

    it('filters out comma-containing injection attempts', () => {
      // An attacker crafting a key like "valid-uuid,__NO_KEYS__" to bypass sentinel
      const malicious = '550e8400-e29b-41d4-a716-446655440000,__NO_KEYS__';
      expect(sanitizeApiKeys([malicious])).toEqual([]);
    });

    it('filters out keys with surrounding whitespace', () => {
      // Whitespace would still be interpolated and could cause query issues
      expect(sanitizeApiKeys([' 550e8400-e29b-41d4-a716-446655440000'])).toEqual([]);
      expect(sanitizeApiKeys(['550e8400-e29b-41d4-a716-446655440000 '])).toEqual([]);
    });
  });
});
