import { action, internalAction, type ActionCtx } from './_generated/server';
import { v } from 'convex/values';
import { SignJWT } from 'jose';
import { requireTraceFlowRole } from './auth';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { RETENTION_DAYS } from '@trace-flow/types';

const adminToken = process.env.TINYBIRD_ADMIN_TOKEN;
const workspaceId = process.env.TINYBIRD_WORKSPACE_ID;
const tinybirdApiUrl = process.env.TINYBIRD_API_URL ?? 'https://api.tinybird.co';

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
  handler: async (ctx, args) => {
    await requireTraceFlowRole(ctx);

    if (!adminToken) {
      throw new Error('TINYBIRD_ADMIN_TOKEN environment variable is not set');
    }

    if (!workspaceId) {
      throw new Error('TINYBIRD_WORKSPACE_ID environment variable is not set');
    }

    // Fetch user's API keys to enforce row-level security
    const user = await ctx.runQuery(api.users.getCurrentUserQuery, {});
    const apiKeyString = user ? await getApiKeyString(ctx, user._id) : '';

    // Look up subscription tier to enforce retention-based filtering
    const subscription = user?.orgId
      ? await ctx.runQuery(internal.subscriptions.getByOrgId, { orgId: user.orgId })
      : null;
    const tier = (subscription?.tier ?? 'hobby') as keyof typeof RETENTION_DAYS;
    const retentionDays = RETENTION_DAYS[tier];

    // Add api_keys and retention_days to fixed_params for server-side enforcement
    // Use sentinel value when user has no keys to prevent matching empty strings
    const scopesWithApiKeys: TinybirdScope[] = args.scopes.map((scope) => ({
      ...scope,
      fixed_params: {
        ...scope.fixed_params,
        api_keys: apiKeyString || '__NO_KEYS__',
        retention_days: retentionDays,
      },
    }));

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

async function getApiKeyString(ctx: ActionCtx, userId: Id<'users'>): Promise<string> {
  const apiKeys = await ctx.runQuery(internal.apiKeys.listByUserId, { userId });
  return apiKeys.map((k: { key: string }) => k.key).join(',');
}

// Internal action for MCP - bypasses Convex auth, requires apiKeys parameter
export const generateTokenInternal = internalAction({
  args: {
    scopes: v.array(v.object({ type: v.string(), resource: v.string() })),
    apiKeys: v.array(v.string()),
    retentionDays: v.optional(v.number()),
    ttl: v.optional(v.number()),
  },
  handler: async (_, args) => {
    // Use sentinel value when no keys to prevent matching empty strings
    const apiKeyString = args.apiKeys.join(',') || '__NO_KEYS__';

    // Add api_keys and retention_days to fixed_params for row-level security
    const scopesWithApiKeys: TinybirdScope[] = args.scopes.map((scope) => ({
      ...scope,
      fixed_params: {
        api_keys: apiKeyString,
        retention_days: args.retentionDays ?? RETENTION_DAYS.hobby,
      },
    }));

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
 * Extends retention for existing traces when a user upgrades from hobby to pro.
 * Updates RetentionExpiresAt and TierAtIngestion in all three datasources.
 *
 * Only extends data that hasn't already expired (RetentionExpiresAt > now).
 */
export const extendRetention = internalAction({
  args: {
    orgId: v.id('organizations'),
  },
  handler: async (ctx, args) => {
    // Get all API keys for this organization
    const apiKeys = await ctx.runQuery(internal.apiKeys.listByOrgId, { orgId: args.orgId });
    const apiKeyStrings = apiKeys.map((k: { key: string }) => k.key);

    if (apiKeyStrings.length === 0) {
      return { updated: false, reason: 'No API keys found for organization' };
    }

    // Calculate the extension: difference between pro and hobby retention in nanoseconds
    const extensionNanos = (RETENTION_DAYS.pro - RETENTION_DAYS.hobby) * NANOSECONDS_PER_DAY;
    const nowNanos = Date.now() * 1_000_000;

    // Validate API keys are UUIDs before interpolating into SQL (defense in depth)
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const validKeys = apiKeyStrings.filter((k: string) => uuidPattern.test(k));
    if (validKeys.length === 0) {
      return { updated: false, reason: 'No valid API keys found for organization' };
    }

    // Format API keys for SQL IN clause
    const apiKeysInClause = validKeys.map((k: string) => `'${k.replace(/'/g, "''")}'`).join(',');

    // Datasources to update
    const datasources = ['otel_traces', 'otel_traces_genai', 'llm_requests'];

    const results: Record<string, { success: boolean; error?: string }> = {};

    for (const datasource of datasources) {
      // Use ALTER TABLE UPDATE to extend retention for all traces with these API keys
      // Only update rows where RetentionExpiresAt > now (not yet expired)
      // and TierAtIngestion is 'hobby' or 'unknown' (not already pro)
      const sql = `
        ALTER TABLE ${datasource}
        UPDATE
          RetentionExpiresAt = RetentionExpiresAt + ${extensionNanos},
          TierAtIngestion = 'pro'
        WHERE ApiKey IN (${apiKeysInClause})
          AND RetentionExpiresAt > ${nowNanos}
          AND TierAtIngestion IN ('hobby', '')
      `;

      const response = await fetch(`${tinybirdApiUrl}/v0/sql`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'text/plain',
        },
        body: sql,
      });

      if (!response.ok) {
        const errorText = await response.text();
        results[datasource] = {
          success: false,
          error: `${response.status}: ${errorText}`,
        };
        console.error(`Failed to extend retention for ${datasource}:`, errorText);
      } else {
        results[datasource] = { success: true };
      }
    }

    return { updated: true, results };
  },
});
