import { action, internalAction, type ActionCtx } from './_generated/server';
import { v } from 'convex/values';
import { SignJWT } from 'jose';
import { requireTraceFlowRole } from './auth';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';

const adminToken = process.env.TINYBIRD_ADMIN_TOKEN;
const workspaceId = process.env.TINYBIRD_WORKSPACE_ID;

if (!adminToken) {
  throw new Error('TINYBIRD_ADMIN_TOKEN environment variable is not set');
}

if (!workspaceId) {
  throw new Error('TINYBIRD_WORKSPACE_ID environment variable is not set');
}

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

    // Add api_keys to fixed_params for row-level security
    // Use sentinel value when user has no keys to prevent matching empty strings
    const scopesWithApiKeys: TinybirdScope[] = args.scopes.map((scope) => ({
      ...scope,
      fixed_params: {
        ...scope.fixed_params,
        api_keys: apiKeyString || '__NO_KEYS__',
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
    ttl: v.optional(v.number()),
  },
  handler: async (_, args) => {
    // Use sentinel value when no keys to prevent matching empty strings
    const apiKeyString = args.apiKeys.join(',') || '__NO_KEYS__';

    // Add api_keys to fixed_params for row-level security
    const scopesWithApiKeys: TinybirdScope[] = args.scopes.map((scope) => ({
      ...scope,
      fixed_params: { api_keys: apiKeyString },
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
