import { action, internalAction } from './_generated/server';
import { v } from 'convex/values';
import { SignJWT } from 'jose';
import { requireTraceFlowRole } from './auth';

const adminToken = process.env.TINYBIRD_ADMIN_TOKEN;
const workspaceId = process.env.TINYBIRD_WORKSPACE_ID;

if (!adminToken) {
  throw new Error('TINYBIRD_ADMIN_TOKEN environment variable is not set');
}

if (!workspaceId) {
  throw new Error('TINYBIRD_WORKSPACE_ID environment variable is not set');
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

    const ttlSeconds = args.ttl ?? 600;
    const expirationTime = Math.floor(Date.now() / 1000) + ttlSeconds;
    const tokenName = args.name ?? `convex_jwt_${Date.now()}`;

    const payload = {
      workspace_id: workspaceId,
      name: tokenName,
      scopes: args.scopes,
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

// Internal action for MCP - bypasses Convex auth
export const generateTokenInternal = internalAction({
  args: {
    scopes: v.array(v.object({ type: v.string(), resource: v.string() })),
    ttl: v.optional(v.number()),
  },
  handler: async (_, args) => {
    const ttlSeconds = args.ttl ?? 600;
    const payload = {
      workspace_id: workspaceId,
      name: `mcp_jwt_${Date.now()}`,
      scopes: args.scopes,
    };

    const secret = new TextEncoder().encode(adminToken);
    return new SignJWT(payload)
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
      .sign(secret);
  },
});
