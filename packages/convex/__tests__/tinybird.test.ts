// tinybird.ts requires TINYBIRD_ADMIN_TOKEN and TINYBIRD_WORKSPACE_ID at module load time.
// These are provided via vitest.config.ts env configuration.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  AGENT_ORG_DATASOURCES,
  buildOrgTraceDeleteStatements,
  buildWebReadScopes,
  joinSanitizedApiKeys,
  LLM_API_KEY_DATASOURCES,
  MCP_TINYBIRD_PIPES,
  sanitizeApiKeys,
  UUID_PATTERN,
  validateMcpTinybirdScopes,
  WEB_READ_TOKEN_TTL_SECONDS,
  WEB_TINYBIRD_PIPES,
  withRowSecurityParams,
} from '../integrations/tinybird';

const EXPECTED_WEB_PIPES = [
  'filter_options',
  'traces_list',
  'traces_grouped',
  'traces_for_alerts',
  'trace_detail',
  'llm_usage_summary',
  'llm_request_stats',
  'llm_usage_timeseries',
  'llm_usage_by_model',
  'llm_usage_by_provider',
  'operations_leaderboard',
  'llm_usage_by_api_key',
  'llm_cost_forecast',
  'operation_user_breakdown',
  'agent_usage_timeseries',
  'agent_usage_summary',
  'agent_session_cost_distribution',
  'agent_cost_by_depth',
  'agent_sessions_browser',
  'agent_notable_changes',
  'agent_context_health',
  'agent_failure_leaderboard',
  'agent_tool_period_delta',
  'agent_repo_directory',
  'agent_review_unit_costs',
  'agent_source_sync_status',
] as const;

const EXPECTED_MCP_PIPES = [
  'mcp_traces_list',
  'mcp_trace_detail',
  'mcp_trace_events',
  'mcp_trace_summaries',
  'mcp_trace_summary',
  'mcp_trace_by_provider',
  'mcp_trace_by_model',
  'llm_usage_summary',
  'operations_leaderboard',
  'llm_usage_by_model',
  'agent_usage_summary',
  'agent_usage_timeseries',
  'agent_usage_breakdown',
  'agent_context_health',
  'agent_failure_leaderboard',
  'agent_tool_period_delta',
  'agent_repo_directory',
  'agent_review_unit_costs',
] as const;

function readPipe(resource: string): string {
  return readFileSync(new URL(`../../../pipes/${resource}.pipe`, import.meta.url), 'utf8');
}

function readAgentOrgDatasources(): string[] {
  const datasourceDir = new URL('../../../datasources/', import.meta.url);
  return readdirSync(datasourceDir)
    .filter((file) => file.startsWith('agent_') && file.endsWith('.datasource'))
    .filter((file) => /\bOrgId\b/.test(readFileSync(new URL(file, datasourceDir), 'utf8')))
    .map((file) => file.replace(/\.datasource$/, ''))
    .sort();
}

describe('Tinybird web read token scopes', () => {
  it('uses a fixed five-minute web token TTL', () => {
    expect(WEB_READ_TOKEN_TTL_SECONDS).toBe(300);
  });

  it('emits only allowlisted PIPES:READ scopes', () => {
    expect(WEB_TINYBIRD_PIPES).toEqual(EXPECTED_WEB_PIPES);
    expect(buildWebReadScopes()).toEqual(
      EXPECTED_WEB_PIPES.map((resource) => ({ type: 'PIPES:READ', resource })),
    );
  });

  it('does not accept caller-provided scopes for web token minting', () => {
    const buildWithIgnoredArg = buildWebReadScopes as unknown as (scopes: unknown[]) => unknown;

    expect(buildWithIgnoredArg([{ type: 'PIPES:READ', resource: 'not_allowlisted' }])).toEqual(
      buildWebReadScopes(),
    );
  });

  it('stamps identical row-security fixed params on every web scope', () => {
    const scopes = withRowSecurityParams(buildWebReadScopes(), {
      apiKeyString: 'key-a,key-b',
      orgId: 'org_123',
      retentionDays: 30,
    });

    expect(scopes).toHaveLength(EXPECTED_WEB_PIPES.length);
    for (const scope of scopes) {
      expect(scope.fixed_params).toEqual({
        api_keys: 'key-a,key-b',
        org_id: 'org_123',
        retention_days: 30,
      });
    }
  });
});

describe('Tinybird MCP read token scopes', () => {
  it('allowlists the published pipes current MCP tools use', () => {
    expect(MCP_TINYBIRD_PIPES).toEqual(EXPECTED_MCP_PIPES);
  });

  it('accepts allowlisted PIPES:READ scopes', () => {
    expect(
      validateMcpTinybirdScopes([
        { type: 'PIPES:READ', resource: 'mcp_traces_list' },
        { type: 'PIPES:READ', resource: 'agent_usage_summary' },
      ]),
    ).toEqual([
      { type: 'PIPES:READ', resource: 'mcp_traces_list' },
      { type: 'PIPES:READ', resource: 'agent_usage_summary' },
    ]);
  });

  it('drops caller fixed params before the signer stamps row security', () => {
    expect(
      validateMcpTinybirdScopes([
        {
          type: 'PIPES:READ',
          resource: 'mcp_traces_list',
          fixed_params: { api_keys: 'attacker-supplied' },
        },
      ]),
    ).toEqual([{ type: 'PIPES:READ', resource: 'mcp_traces_list' }]);
  });

  it.each([
    ['empty scopes', [], /must not be empty/],
    [
      'datasource scopes',
      [{ type: 'DATASOURCES:READ', resource: 'otel_trace_spans' }],
      /scope type is not allowed/,
    ],
    ['SQL scopes', [{ type: 'SQL:READ', resource: 'select 1' }], /scope type is not allowed/],
    ['unknown pipes', [{ type: 'PIPES:READ', resource: 'not_allowlisted' }], /pipe is not allowed/],
    [
      'helper pipes',
      [{ type: 'PIPES:READ', resource: 'agent_priced_usage' }],
      /pipe is not allowed/,
    ],
    ['empty resources', [{ type: 'PIPES:READ', resource: '' }], /pipe is not allowed/],
  ] as const)('rejects %s', (_name, scopes, message) => {
    expect(() => validateMcpTinybirdScopes([...scopes])).toThrow(message);
  });

  it('keeps every allowlisted pipe as an endpoint with fixed-param row security', () => {
    for (const resource of MCP_TINYBIRD_PIPES) {
      const pipe = readPipe(resource);
      if (!/\bTYPE\s+ENDPOINT\b/.test(pipe)) {
        throw new Error(`${resource} is not a Tinybird endpoint pipe`);
      }
      if (!pipe.includes('String(api_keys') && !pipe.includes('String(org_id')) {
        throw new Error(`${resource} does not filter on fixed-param row security`);
      }
    }
  });
});

describe('Tinybird org deletion SQL', () => {
  it('covers every org-scoped agent datasource', () => {
    expect([...AGENT_ORG_DATASOURCES].sort()).toEqual(readAgentOrgDatasources());
  });

  it('deletes both API-key scoped LLM rows and org-scoped agent rows', () => {
    const apiKey = '11111111-1111-1111-1111-111111111111';
    const statements = buildOrgTraceDeleteStatements({ apiKeys: [apiKey], orgId: 'org_123' });

    expect(statements.map((statement) => statement.datasource)).toEqual([
      ...LLM_API_KEY_DATASOURCES,
      ...AGENT_ORG_DATASOURCES,
    ]);
    expect(statements.find((statement) => statement.datasource === 'llm_request_facts')?.sql).toBe(
      `ALTER TABLE llm_request_facts DELETE WHERE ApiKey IN ('${apiKey}')`,
    );
    expect(
      statements.find((statement) => statement.datasource === 'agent_message_facts')?.sql,
    ).toBe("ALTER TABLE agent_message_facts DELETE WHERE OrgId = 'org_123'");
  });

  it('still deletes agent analytics when an org has no valid API keys', () => {
    const statements = buildOrgTraceDeleteStatements({
      apiKeys: ['not-a-valid-api-key'],
      orgId: 'org_123',
    });

    expect(statements.map((statement) => statement.datasource)).toEqual([...AGENT_ORG_DATASOURCES]);
    expect(statements.every((statement) => statement.sql.includes("WHERE OrgId = 'org_123'"))).toBe(
      true,
    );
  });

  it('escapes org ids before interpolating them into SQL', () => {
    const statements = buildOrgTraceDeleteStatements({ apiKeys: [], orgId: "org_'quoted" });

    expect(statements[0]?.sql).toContain("OrgId = 'org_''quoted'");
  });
});

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
