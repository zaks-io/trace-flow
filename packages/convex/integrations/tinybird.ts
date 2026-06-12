import { action, internalAction, type ActionCtx } from '../_generated/server';
import { v } from 'convex/values';
import { SignJWT } from 'jose';
import { runAdminSql, TinybirdQueryError } from '@trace-flow/tinybird-client';
import { requireAuthenticated } from '../auth/auth';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { RETENTION_DAYS } from '@trace-flow/types';
import { rateLimiter } from '../rateLimits';
import { assertMintableTinybirdScopes } from './tinybirdScopes';

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

// Sentinels keep a token scoped to nothing rather than matching empty strings,
// so a keyless/orgless caller can never read another tenant's rows.
const NO_KEYS_SENTINEL = '__NO_KEYS__';
const NO_ORG_SENTINEL = '__NO_ORG__';

/**
 * Stamp the row-security fixed_params onto every scope. `api_keys` +
 * `retention_days` gate the `llm_request_facts` pipes; `org_id` gates the agent
 * pipes (which deliberately do NOT use `api_keys`). Both token-minting paths
 * (`generateToken` and the MCP `generateTokenInternal`) build their fixed_params
 * here so neither can silently issue a token missing `org_id`.
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

export const generateToken = action({
  args: {
    scopes: v.array(
      v.object({
        type: v.string(),
        resource: v.string(),
        fixed_params: v.optional(v.record(v.string(), v.any())),
      }),
    ),
    ttl: v.optional(v.number()),
    name: v.optional(v.string()),
  },
  returns: v.object({
    token: v.string(),
    expiresAt: v.number(),
    name: v.string(),
  }),
  handler: async (ctx, args) => {
    await requireAuthenticated(ctx);

    if (!adminToken) {
      throw new Error('TINYBIRD_ADMIN_TOKEN environment variable is not set');
    }

    if (!workspaceId) {
      throw new Error('TINYBIRD_WORKSPACE_ID environment variable is not set');
    }

    // Fetch org-visible API keys (same scope as apiKeys.list / MCP listForUser)
    const user = await ctx.runQuery(api.auth.users.getCurrentUserQuery, {});

    if (user) {
      await rateLimiter.limit(ctx, 'generateTinybirdJwt', { key: user._id, throws: true });
    }

    const apiKeyString = user ? await getApiKeyString(ctx, user._id) : '';

    // Look up subscription tier to enforce retention-based filtering
    const subscription = user?.orgId
      ? await ctx.runQuery(internal.billing.subscriptions.getByOrgId, { orgId: user.orgId })
      : null;
    const tier = subscription?.tier ?? 'hobby';
    const retentionDays = RETENTION_DAYS[tier];

    assertMintableTinybirdScopes(args.scopes);

    const scopesWithApiKeys = withRowSecurityParams(args.scopes, {
      apiKeyString,
      retentionDays,
      orgId: user?.orgId ?? '',
    });

    const ttlSeconds = args.ttl ?? 600;
    const expirationTime = Math.floor(Date.now() / 1000) + ttlSeconds;
    const tokenName = args.name ?? `convex_jwt_${Date.now()}`;

    const payload = {
      workspace_id: workspaceId,
      name: tokenName,
      scopes: scopesWithApiKeys,
    };

    const secret = new TextEncoder().encode(adminToken);
    const token = await new SignJWT(payload)
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime(expirationTime)
      .sign(secret);

    return {
      token,
      expiresAt: expirationTime,
      name: tokenName,
    };
  },
});

// Validate API keys are UUIDs before interpolating into JWT fixed_params (defense in depth).
// Matches the same pattern used in extendRetention. Exported for unit testing.
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Exported for unit testing.
export function sanitizeApiKeys(keys: string[]): string[] {
  return keys.filter((k) => UUID_PATTERN.test(k));
}

/** Build comma-separated api_keys for JWT fixed_params from key docs (e.g. listForUser). */
export function joinSanitizedApiKeys(apiKeys: { key: string }[]): string {
  return sanitizeApiKeys(apiKeys.map((k) => k.key)).join(',');
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
    assertMintableTinybirdScopes(args.scopes);

    // Validate API keys are UUIDs before inclusion in JWT (defense in depth)
    const validKeys = sanitizeApiKeys(args.apiKeys);

    // Same fixed_param builder as generateToken — always emits org_id (sentinel
    // when the caller has no org), so the MCP path can never issue an agent JWT
    // that is unscoped on org_id.
    const scopesWithApiKeys = withRowSecurityParams(args.scopes, {
      apiKeyString: validKeys.join(','),
      retentionDays: args.retentionDays ?? RETENTION_DAYS.hobby,
      orgId: args.orgId ?? '',
    });

    const ttlSeconds = args.ttl ?? 600;
    const payload = {
      workspace_id: workspaceId,
      name: `mcp_jwt_${Date.now()}`,
      scopes: scopesWithApiKeys,
    };

    const secret = new TextEncoder().encode(adminToken);
    return new SignJWT(payload)
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
      .sign(secret);
  },
});

/**
 * Deletes all trace data for an organization across all Tinybird datasources.
 * Uses ALTER TABLE DELETE with ApiKey filtering (same pattern as extendRetention).
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

    if (apiKeyStrings.length === 0) {
      return { deleted: false as const, reason: 'No API keys found for organization' };
    }

    const validKeys = sanitizeApiKeys(apiKeyStrings);
    if (validKeys.length === 0) {
      return { deleted: false as const, reason: 'No valid API keys found for organization' };
    }

    const apiKeysInClause = validKeys.map((k: string) => `'${k}'`).join(',');

    const datasources = [
      'otel_trace_spans',
      'otel_genai_spans',
      'llm_request_facts',
      'llm_usage_hourly',
      'llm_usage_daily',
      'llm_usage_monthly',
    ];

    const results: Record<string, { success: boolean; error?: string }> = {};

    for (const datasource of datasources) {
      const sql = `ALTER TABLE ${datasource} DELETE WHERE ApiKey IN (${apiKeysInClause})`;

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
