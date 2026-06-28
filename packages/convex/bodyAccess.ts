import { SignJWT } from 'jose';
import { action, internalQuery } from './_generated/server';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import {
  BODY_ACCESS_TOKEN_AUDIENCE,
  BODY_ACCESS_TOKEN_ISSUER,
  BODY_ACCESS_TOKEN_SCOPE,
  BODY_ACCESS_TOKEN_TTL_SECONDS,
} from '@trace-flow/types';
import { extractSub, requireEnabledUser } from './auth/users';
import { rateLimiter } from './rateLimits';

function getBodyAccessSecret(): Uint8Array {
  const secret = process.env.BODY_ACCESS_JWT_SECRET;
  if (!secret) throw new Error('BODY_ACCESS_JWT_SECRET environment variable is not set');
  return new TextEncoder().encode(secret);
}

function assertValidRequestId(requestId: string) {
  if (requestId.length === 0 || requestId.length > 256 || requestId.includes('/')) {
    throw new Error('Invalid request id');
  }
}

export function bodyAccessRateLimitKey(userId: string): string {
  return userId;
}

export const currentSubject = internalQuery({
  args: {},
  returns: v.object({
    sub: v.string(),
    userId: v.id('users'),
    orgId: v.id('organizations'),
  }),
  handler: async (ctx) => {
    const user = await requireEnabledUser(ctx);
    if (!user.orgId) throw new Error('Active organization membership required');

    const [membership, org] = await Promise.all([
      ctx.db
        .query('organizationMembers')
        .withIndex('by_user_id', (q) => q.eq('userId', user._id))
        .filter((q) => q.eq(q.field('orgId'), user.orgId!))
        .filter((q) => q.eq(q.field('status'), 'active'))
        .first(),
      ctx.db.get(user.orgId),
    ]);

    if (!membership || !org || org.deletedAt) {
      throw new Error('Active organization membership required');
    }

    const sub = user.tokenIdentifier ? extractSub(user.tokenIdentifier) : null;
    if (!sub) throw new Error('Authenticated subject is unavailable');

    return { sub, userId: user._id, orgId: user.orgId };
  },
});

export const issueToken = action({
  args: { requestId: v.string() },
  returns: v.object({
    token: v.string(),
    expiresAt: v.number(),
  }),
  handler: async (ctx, args) => {
    assertValidRequestId(args.requestId);
    const subject = await ctx.runQuery(internal.bodyAccess.currentSubject, {});

    await rateLimiter.limit(ctx, 'bodyAccessToken', {
      key: bodyAccessRateLimitKey(subject.userId),
      throws: true,
    });

    const expiresAt = Math.floor(Date.now() / 1000) + BODY_ACCESS_TOKEN_TTL_SECONDS;
    const token = await new SignJWT({
      sub: subject.sub,
      orgId: subject.orgId,
      requestId: args.requestId,
      scope: BODY_ACCESS_TOKEN_SCOPE,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(BODY_ACCESS_TOKEN_ISSUER)
      .setAudience(BODY_ACCESS_TOKEN_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(expiresAt)
      .sign(getBodyAccessSecret());

    return { token, expiresAt };
  },
});
