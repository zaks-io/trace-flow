// tinybird.ts requires TINYBIRD_ADMIN_TOKEN and TINYBIRD_WORKSPACE_ID at module load time.
// These are provided via vitest.config.ts env configuration.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { joinSanitizedApiKeys, sanitizeApiKeys, UUID_PATTERN } from '../integrations/tinybird';
import {
  ALLOWED_TINYBIRD_PIPE_RESOURCES,
  assertMintableTinybirdScopes,
  TINYBIRD_PIPES_READ_SCOPE,
} from '../integrations/tinybirdScopes';
import { assertRowSecuredEndpointPipe } from './tinybirdPipeValidation';

const PIPES_DIR = join(__dirname, '../../../pipes');

function listShippedPipes(): string[] {
  return readdirSync(PIPES_DIR)
    .filter((name) => name.endsWith('.pipe'))
    .map((name) => name.slice(0, -'.pipe'.length))
    .sort();
}

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

  describe('assertMintableTinybirdScopes', () => {
    it('accepts PIPES:READ on allowlisted dashboard pipes', () => {
      expect(() =>
        assertMintableTinybirdScopes([
          { type: TINYBIRD_PIPES_READ_SCOPE, resource: 'traces_list' },
          { type: TINYBIRD_PIPES_READ_SCOPE, resource: 'trace_detail' },
        ]),
      ).not.toThrow();
    });

    it('accepts PIPES:READ on allowlisted MCP pipes', () => {
      expect(() =>
        assertMintableTinybirdScopes([
          { type: TINYBIRD_PIPES_READ_SCOPE, resource: 'mcp_traces_list' },
        ]),
      ).not.toThrow();
    });

    it('accepts PIPES:READ on agent_context_health (dashboard + MCP)', () => {
      expect(() =>
        assertMintableTinybirdScopes([
          { type: TINYBIRD_PIPES_READ_SCOPE, resource: 'agent_context_health' },
        ]),
      ).not.toThrow();
    });

    it('rejects DATASOURCES:READ scopes', () => {
      expect(() =>
        assertMintableTinybirdScopes([{ type: 'DATASOURCES:READ', resource: 'otel_traces' }]),
      ).toThrow(/scope type not allowed/i);
    });

    it('rejects SQL:READ scopes', () => {
      expect(() =>
        assertMintableTinybirdScopes([{ type: 'SQL:READ', resource: 'otel_traces' }]),
      ).toThrow(/scope type not allowed/i);
    });

    it('rejects PIPES:READ on unknown pipe names', () => {
      expect(() =>
        assertMintableTinybirdScopes([
          { type: TINYBIRD_PIPES_READ_SCOPE, resource: 'otel_traces' },
        ]),
      ).toThrow(/pipe not allowed/i);
    });

    it('rejects PIPES:READ on helper pipes without row security (agent_priced_usage)', () => {
      expect(() =>
        assertMintableTinybirdScopes([
          { type: TINYBIRD_PIPES_READ_SCOPE, resource: 'agent_priced_usage' },
        ]),
      ).toThrow(/pipe not allowed/i);
    });

    it('rejects PIPES:READ on row-secured endpoints not exposed to dashboard/MCP', () => {
      expect(() =>
        assertMintableTinybirdScopes([
          { type: TINYBIRD_PIPES_READ_SCOPE, resource: 'agent_priced_coverage' },
        ]),
      ).toThrow(/pipe not allowed/i);
    });

    it('rejects empty scope lists', () => {
      expect(() => assertMintableTinybirdScopes([])).toThrow(/at least one/i);
    });

    it('every JWT-mintable pipe is TYPE ENDPOINT with api_keys or org_id filter', () => {
      for (const pipe of ALLOWED_TINYBIRD_PIPE_RESOURCES) {
        expect(() => assertRowSecuredEndpointPipe(pipe, PIPES_DIR)).not.toThrow();
      }
    });

    it('shipped helper pipes are not JWT-mintable', () => {
      expect(ALLOWED_TINYBIRD_PIPE_RESOURCES.has('agent_priced_usage')).toBe(false);
      expect(() => assertRowSecuredEndpointPipe('agent_priced_usage', PIPES_DIR)).toThrow(
        /TYPE ENDPOINT/i,
      );
    });

    it('shipped pipes inventory is larger than the JWT allowlist', () => {
      const shippedPipes = listShippedPipes();
      const allowlistedPipes = [...ALLOWED_TINYBIRD_PIPE_RESOURCES].sort();

      expect(shippedPipes.length).toBeGreaterThan(allowlistedPipes.length);
      for (const pipe of allowlistedPipes) {
        expect(shippedPipes).toContain(pipe);
      }
    });
  });

  describe('joinSanitizedApiKeys', () => {
    it('includes org-shared and member-owned keys in one comma-separated string', () => {
      // Mirrors listForUser: org keys (e.g. created by owner) plus user keys
      const docs = [
        { key: '11111111-1111-1111-1111-111111111111' },
        { key: '22222222-2222-2222-2222-222222222222' },
      ];
      expect(joinSanitizedApiKeys(docs)).toBe(
        '11111111-1111-1111-1111-111111111111,22222222-2222-2222-2222-222222222222',
      );
    });

    it('filters invalid keys and still includes valid org keys', () => {
      const docs = [
        { key: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
        { key: "bad'; DROP TABLE--" },
        { key: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' },
      ];
      expect(joinSanitizedApiKeys(docs)).toBe(
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa,bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      );
    });

    it('returns empty string when no valid keys remain', () => {
      expect(joinSanitizedApiKeys([{ key: 'not-a-uuid' }])).toBe('');
      expect(joinSanitizedApiKeys([])).toBe('');
    });
  });
});
