// tinybird.ts requires TINYBIRD_ADMIN_TOKEN and TINYBIRD_WORKSPACE_ID at module load time.
// These are provided via vitest.config.ts env configuration.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  AGENT_ORG_DATASOURCES,
  buildOrgTraceDeleteStatements,
  buildWebReadScopes,
  joinAnalyticsKeyIds,
  LLM_API_KEY_DATASOURCES,
  MCP_TINYBIRD_PIPES,
  sanitizeAnalyticsKeyIds,
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
  'llm_cost_tail_risk',
  'llm_token_ratio_drift',
  'operation_user_breakdown',
  'agent_usage_timeseries',
  'agent_usage_summary',
  'agent_usage_breakdown',
  'agent_session_cost_distribution',
  'agent_cost_by_depth',
  'agent_sessions_browser',
  'agent_notable_changes',
  'agent_context_health',
  'agent_failure_leaderboard',
  'agent_tool_period_delta',
  'agent_repo_directory',
  'agent_review_unit_costs',
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

  it('does not accept caller-provided scope arrays for web token minting', () => {
    const buildWithIgnoredArg = buildWebReadScopes as unknown as (scopes: unknown[]) => unknown;

    expect(() =>
      buildWithIgnoredArg([{ type: 'PIPES:READ', resource: 'not_allowlisted' }]),
    ).toThrow(/not allowed/);
  });

  it('can mint a single allowlisted web pipe scope', () => {
    expect(buildWebReadScopes('agent_usage_summary')).toEqual([
      { type: 'PIPES:READ', resource: 'agent_usage_summary' },
    ]);
  });

  it.each(['llm_cost_tail_risk', 'llm_token_ratio_drift'])(
    'allows the shipped Usage pipe %s',
    (resource) => {
      expect(buildWebReadScopes(resource)).toEqual([{ type: 'PIPES:READ', resource }]);
    },
  );

  it('rejects unknown web pipe scopes', () => {
    expect(() => buildWebReadScopes('not_allowlisted')).toThrow(/not allowed/);
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
    const analyticsKeyId = `sha256:${'1'.repeat(64)}`;
    const statements = buildOrgTraceDeleteStatements({
      analyticsKeyIds: [analyticsKeyId],
      orgId: 'org_123',
    });

    expect(statements.map((statement) => statement.datasource)).toEqual([
      ...LLM_API_KEY_DATASOURCES,
      ...AGENT_ORG_DATASOURCES,
    ]);
    expect(statements.find((statement) => statement.datasource === 'llm_request_facts')?.sql).toBe(
      `ALTER TABLE llm_request_facts DELETE WHERE if(match(ApiKey, '^sha256:[0-9a-f]{64}$'), ApiKey, concat('sha256:', lower(hex(SHA256(ApiKey))))) IN ('${analyticsKeyId}')`,
    );
    expect(
      statements.find((statement) => statement.datasource === 'agent_message_facts')?.sql,
    ).toBe("ALTER TABLE agent_message_facts DELETE WHERE OrgId = 'org_123'");
  });

  it('still deletes agent analytics when an org has no valid API keys', () => {
    const statements = buildOrgTraceDeleteStatements({
      analyticsKeyIds: ['not-a-valid-analytics-key-id'],
      orgId: 'org_123',
    });

    expect(statements.map((statement) => statement.datasource)).toEqual([...AGENT_ORG_DATASOURCES]);
    expect(statements.every((statement) => statement.sql.includes("WHERE OrgId = 'org_123'"))).toBe(
      true,
    );
  });

  it('escapes org ids before interpolating them into SQL', () => {
    const statements = buildOrgTraceDeleteStatements({
      analyticsKeyIds: [],
      orgId: "org_'quoted",
    });

    expect(statements[0]?.sql).toContain("OrgId = 'org_''quoted'");
  });
});

describe('tinybird analytics key identifier sanitization', () => {
  it('accepts only canonical lowercase SHA-256 identifiers', () => {
    const valid = [`sha256:${'a'.repeat(64)}`, `sha256:${'0'.repeat(64)}`];

    expect(
      sanitizeAnalyticsKeyIds([
        ...valid,
        '550e8400-e29b-41d4-a716-446655440000',
        `sha256:${'A'.repeat(64)}`,
        `sha256:${'a'.repeat(63)}`,
        `sha256:${'a'.repeat(64)},__NO_KEYS__`,
        "sha256:'; DROP TABLE--",
      ]),
    ).toEqual(valid);
  });

  it('hashes credentials before joining token fixed params', async () => {
    const joined = await joinAnalyticsKeyIds([{ key: 'key-1' }, { key: 'key-2' }]);

    expect(joined).toBe(
      'sha256:be2974546978e3739e6d6da85c4be9f334ce32df2b9fd4b6ff1b55c0d57e9d44,sha256:7c36b0a9dedde119c75165957c6c9c187e65df1ee5db87c4c58ad503ad88cbe3',
    );
    expect(joined).not.toContain('key-');
    expect(await joinAnalyticsKeyIds([])).toBe('');
  });
});
