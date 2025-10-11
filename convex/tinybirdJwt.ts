import { action } from './_generated/server';
import { v } from 'convex/values';
import { SignJWT } from 'jose';

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
  handler: async (_ctx, args) => {
    const adminToken = process.env.TINYBIRD_ADMIN_TOKEN;
    const workspaceId = process.env.TINYBIRD_WORKSPACE_ID;

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
