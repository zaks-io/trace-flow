import { action, internalAction, type ActionCtx } from '../_generated/server';
import { v } from 'convex/values';
import { SignJWT } from 'jose';
import { runAdminSql, TinybirdQueryError } from '@trace-flow/tinybird-client';
import { requireAuthenticated } from '../auth/auth';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { RETENTION_DAYS } from '@trace-flow/types';
import { rateLimiter } from '../rateLimits';
import { sanitizeApiKeys, sqlStringLiteral, UUID_PATTERN } from '../tinybirdSql';

export { sanitizeApiKeys, UUID_PATTERN } from '../tinybirdSql';

const adminToken = process.env.TINYBIRD_ADMIN_TOKEN;
const workspaceId = process.env.TINYBIRD_WORKSPACE_ID;
const tinybirdApiUrl = process.env.TINYBIRD_API_URL ?? 'https://api.us-west-2.aws.tinybird.co';

if (!adminToken) {
  throw new Error('TINYBIRD_ADMIN_TOKEN environment variable is not set');
}

if (!workspaceId) {
  throw new Error('TINYBIRD_WORKSPACE_ID environment variable is not set');
}

const NANOSECONDS_PER_DAY = 24 * 60 * 60 * 1_000_000_000;

interface TinybirdScope {
  type: string;
  resource: string;
  fixed_params?: Record<string, unknown>;
}

export const WEB_READ_TOKEN_TTL_SECONDS = 5 * 60;

export const WEB_TINYBIRD_PIPES = [
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

export const MCP_TINYBIRD_PIPES = [
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

const MCP_TINYBIRD_PIPE_SET = new Set<string>(MCP_TINYBIRD_PIPES);

// Sentinels keep a token scoped to nothing rather than matching empty strings,
// so a keyless/orgless caller can never read another tenant's rows.
const NO_KEYS_SENTINEL = '__NO_KEYS__';
const NO_ORG_SENTINEL = '__NO_ORG__';

/**
 * Stamp the row-security fixed_params onto every scope. `api_keys` +
 * `retention_days` gate the `llm_request_facts` pipes; `org_id` gates the agent
 * pipes (which deliberately do NOT use `api_keys`). Both token-minting paths
 * (`generateWebReadToken` and the MCP `generateTokenInternal`) build their
 * fixed_params here so neither can silently issue a token missing `org_id`.
 */
export function withRowSecurityParams(
  scopes: TinybirdScope[],
  params: { apiKeyString: string; retentionDays: number; orgId: string },
): TinybirdScope[] {
  return scopes.map((scope) => ({
    ...scope,
    fixed_params: {
      ...scope.fixed_params,
      api_keys: params.apiKeyString || NO_KEYS_SENTINEL,
      retention_days: params.retentionDays,
      org_id: params.orgId || NO_ORG_SENTINEL,
    },
  }));
}

export function buildWebReadScopes(): TinybirdScope[] {
  return WEB_TINYBIRD_PIPES.map((resource) => ({ type: 'PIPES:READ', resource }));
}

export function validateMcpTinybirdScopes(scopes: TinybirdScope[]): TinybirdScope[] {
  if (scopes.length === 0) {
    throw new Error('Tinybird MCP scopes must not be empty');
  }

  return scopes.map((scope) => {
    if (scope.type !== 'PIPES:READ') {
      throw new Error(`Tinybird MCP scope type is not allowed: ${scope.type}`);
    }
    if (!MCP_TINYBIRD_PIPE_SET.has(scope.resource)) {
      throw new Error(`Tinybird MCP pipe is not allowed: ${scope.resource}`);
    }
    return { type: 'PIPES:READ', resource: scope.resource };
  });
}

async function signTinybirdToken(
  scopes: TinybirdScope[],
  opts: { name: string; ttlSeconds: number },
): Promise<{ token: string; expiresAt: number; name: string }> {
  const expiresAt = Math.floor(Date.now() / 1000) + opts.ttlSeconds;
  const payload = {
    workspace_id: workspaceId,
    name: opts.name,
    scopes,
  };

  const secret = new TextEncoder().encode(adminToken);
  const token = await new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(expiresAt)
    .sign(secret);

  return {
    token,
    expiresAt,
    name: opts.name,
  };
}

async function getUserRowSecurityParams(
  ctx: ActionCtx,
): Promise<{ apiKeyString: string; retentionDays: number; orgId: string }> {
  const user = await ctx.runQuery(api.auth.users.getCurrentUserQuery, {});

  if (user) {
    await rateLimiter.limit(ctx, 'generateTinybirdJwt', { key: user._id, throws: true });
  }

  const apiKeyString = user ? await getApiKeyString(ctx, user._id) : '';
  const subscription = user?.orgId
    ? await ctx.runQuery(internal.billing.subscriptions.getByOrgId, { orgId: user.orgId })
    : null;
  const tier = subscription?.tier ?? 'hobby';

  return {
    apiKeyString,
    retentionDays: RETENTION_DAYS[tier],
    orgId: user?.orgId ?? '',
  };
}

export const generateWebReadToken = action({
  args: {},
  returns: v.object({
    token: v.string(),
    expiresAt: v.number(),
    name: v.string(),
  }),
  handler: async (ctx) => {
    await requireAuthenticated(ctx);

    if (!adminToken) {
      throw new Error('TINYBIRD_ADMIN_TOKEN environment variable is not set');
    }

    if (!workspaceId) {
      throw new Error('TINYBIRD_WORKSPACE_ID environment variable is not set');
    }

    const scopes = withRowSecurityParams(buildWebReadScopes(), await getUserRowSecurityParams(ctx));

    return signTinybirdToken(scopes, {
      ttlSeconds: WEB_READ_TOKEN_TTL_SECONDS,
      name: `web_read_jwt_${Date.now()}`,
    });
  },
});

/** Build comma-separated api_keys for JWT fixed_params from key docs (e.g. listForUser). */
export function joinSanitizedApiKeys(apiKeys: { key: string }[]): string {
  return sanitizeApiKeys(apiKeys.map((k) => k.key)).join(',');
}

export const LLM_API_KEY_DATASOURCES = [
  'otel_trace_spans',
  'otel_genai_spans',
  'llm_request_facts',
  'llm_usage_hourly',
  'llm_usage_daily',
  'llm_usage_monthly',
] as const;

export const AGENT_ORG_DATASOURCES = [
  'agent_capability_snapshot_facts',
  'agent_context_call_buckets_hourly',
  'agent_file_event_facts',
  'agent_message_facts',
  'agent_pull_request_facts',
  'agent_repositories',
  'agent_review_unit_attributions',
  'agent_session_summaries',
  'agent_tool_event_facts',
  'agent_tool_usage_daily',
  'agent_tool_usage_hourly',
  'agent_usage_daily',
  'agent_usage_hourly',
] as const;

interface TinybirdDeleteStatement {
  datasource: string;
  sql: string;
}

export function buildOrgTraceDeleteStatements(params: {
  apiKeys: string[];
  orgId: string;
}): TinybirdDeleteStatement[] {
  const validKeys = sanitizeApiKeys(params.apiKeys);
  const statements: TinybirdDeleteStatement[] = [];

  if (validKeys.length > 0) {
    const apiKeysInClause = validKeys.map(sqlStringLiteral).join(',');
    statements.push(
      ...LLM_API_KEY_DATASOURCES.map((datasource) => ({
        datasource,
        sql: `ALTER TABLE ${datasource} DELETE WHERE ApiKey IN (${apiKeysInClause})`,
      })),
    );
  }

  const orgIdLiteral = sqlStringLiteral(params.orgId);
  statements.push(
    ...AGENT_ORG_DATASOURCES.map((datasource) => ({
      datasource,
      sql: `ALTER TABLE ${datasource} DELETE WHERE OrgId = ${orgIdLiteral}`,
    })),
  );

  return statements;
}

async function getApiKeyString(ctx: ActionCtx, userId: Id<'users'>): Promise<string> {
  const apiKeys = await ctx.runQuery(internal.apiKeys.listForUser, { userId });
  return joinSanitizedApiKeys(apiKeys);
}

// Internal action for MCP - bypasses Convex auth, requires apiKeys parameter
export const generateTokenInternal = internalAction({
  args: {
    scopes: v.array(v.object({ type: v.string(), resource: v.string() })),
    apiKeys: v.array(v.string()),
    retentionDays: v.optional(v.number()),
    orgId: v.optional(v.string()),
    ttl: v.optional(v.number()),
  },
  returns: v.string(),
  handler: async (_, args) => {
    // Validate API keys are UUIDs before inclusion in JWT (defense in depth)
    const validKeys = sanitizeApiKeys(args.apiKeys);

    // Same fixed_param builder as the web token path: always emits org_id
    // (sentinel when the caller has no org), so MCP cannot issue an agent JWT
    // that is unscoped on org_id.
    const scopesWithApiKeys = withRowSecurityParams(validateMcpTinybirdScopes(args.scopes), {
      apiKeyString: validKeys.join(','),
      retentionDays: args.retentionDays ?? RETENTION_DAYS.hobby,
      orgId: args.orgId ?? '',
    });

    const result = await signTinybirdToken(scopesWithApiKeys, {
      ttlSeconds: args.ttl ?? 600,
      name: `mcp_jwt_${Date.now()}`,
    });
    return result.token;
  },
});

/**
 * Deletes all trace data for an organization across Tinybird datasources.
 * LLM traces are API-key scoped; agent analytics rows are org scoped and must
 * still be deleted when an org has no API keys left.
 */
export const deleteOrgTraces = internalAction({
  args: {
    orgId: v.id('organizations'),
  },
  returns: v.union(
    v.object({ deleted: v.literal(false), reason: v.string() }),
    v.object({
      deleted: v.literal(true),
      results: v.record(
        v.string(),
        v.object({ success: v.boolean(), error: v.optional(v.string()) }),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    const apiKeys = await ctx.runQuery(internal.apiKeys.listByOrgId, { orgId: args.orgId });
    const apiKeyStrings = apiKeys.map((k: { key: string }) => k.key);
    const statements = buildOrgTraceDeleteStatements({ apiKeys: apiKeyStrings, orgId: args.orgId });

    const results: Record<string, { success: boolean; error?: string }> = {};

    for (const { datasource, sql } of statements) {
      try {
        await runAdminSql({ baseUrl: tinybirdApiUrl, adminToken, sql });
        results[datasource] = { success: true };
      } catch (err) {
        const message = err instanceof TinybirdQueryError ? err.message : (err as Error).message;
        results[datasource] = { success: false, error: message };
        console.error(`Failed to delete traces for ${datasource}:`, message);
      }
    }

    return { deleted: true as const, results };
  },
});

/**
 * Extends retention for existing traces when a user upgrades from hobby to pro.
 * Updates RetentionExpiresAt and TierAtIngestion in all three datasources.
 *
 * Only extends data that hasn't already expired (RetentionExpiresAt > now).
 */
export const extendRetention = internalAction({
  args: {
    orgId: v.id('organizations'),
  },
  returns: v.union(
    v.object({ updated: v.literal(false), reason: v.string() }),
    v.object({
      updated: v.literal(true),
      results: v.record(
        v.string(),
        v.object({ success: v.boolean(), error: v.optional(v.string()) }),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    // Get all API keys for this organization
    const apiKeys = await ctx.runQuery(internal.apiKeys.listByOrgId, { orgId: args.orgId });
    const apiKeyStrings = apiKeys.map((k: { key: string }) => k.key);

    if (apiKeyStrings.length === 0) {
      return { updated: false as const, reason: 'No API keys found for organization' };
    }

    // Calculate the extension: difference between pro and hobby retention in nanoseconds
    const extensionNanos = (RETENTION_DAYS.pro - RETENTION_DAYS.hobby) * NANOSECONDS_PER_DAY;
    const nowNanos = Date.now() * 1_000_000;

    // Validate API keys are UUIDs before interpolating into SQL (defense in depth)
    const validKeys = apiKeyStrings.filter((k: string) => UUID_PATTERN.test(k));
    if (validKeys.length === 0) {
      return { updated: false as const, reason: 'No valid API keys found for organization' };
    }

    // Format API keys for SQL IN clause (safe: UUID_PATTERN guarantees only hex + dashes)
    const apiKeysInClause = validKeys.map((k: string) => `'${k}'`).join(',');

    // Datasources to update
    const datasources = ['otel_trace_spans', 'otel_genai_spans', 'llm_request_facts'];

    const results: Record<string, { success: boolean; error?: string }> = {};

    for (const datasource of datasources) {
      // ALTER TABLE UPDATE extends retention for all traces with these API keys.
      // Only rows where RetentionExpiresAt > now (not yet expired) and
      // TierAtIngestion is 'hobby' or '' (not already pro).
      const sql = `
        ALTER TABLE ${datasource}
        UPDATE
          RetentionExpiresAt = RetentionExpiresAt + ${extensionNanos},
          TierAtIngestion = 'pro'
        WHERE ApiKey IN (${apiKeysInClause})
          AND RetentionExpiresAt > ${nowNanos}
          AND TierAtIngestion IN ('hobby', '')
      `;

      try {
        await runAdminSql({ baseUrl: tinybirdApiUrl, adminToken, sql });
        results[datasource] = { success: true };
      } catch (err) {
        const message = err instanceof TinybirdQueryError ? err.message : (err as Error).message;
        results[datasource] = { success: false, error: message };
        console.error(`Failed to extend retention for ${datasource}:`, message);
      }
    }

    return { updated: true as const, results };
  },
});
