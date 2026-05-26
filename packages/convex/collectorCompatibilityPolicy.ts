import { internalQuery, mutation, query } from './_generated/server';
import type { QueryCtx } from './_generated/server';
import { v, type Infer } from 'convex/values';
import { requireAuthenticated } from './auth/auth';
import { requireEnabledUser } from './auth/users';

// Worker-side compatibility policy, owned in Convex so minimum versions and the
// emergency denylist change without a Worker deploy. The active policy is the
// most recently updated row; an empty table means the Worker fails closed with
// `policy_unavailable` rather than accepting unknown client versions.

const policyValidator = v.object({
  minDesktopVersion: v.string(),
  minParserVersion: v.string(),
  denylistedVersions: v.array(v.string()),
  updatedAt: v.number(),
});

type ActivePolicy = Infer<typeof policyValidator>;

async function readActivePolicy(ctx: QueryCtx): Promise<ActivePolicy | null> {
  const latest = await ctx.db
    .query('collectorCompatibilityPolicy')
    .withIndex('by_updated_at')
    .order('desc')
    .first();
  if (!latest) return null;
  return {
    minDesktopVersion: latest.minDesktopVersion,
    minParserVersion: latest.minParserVersion,
    denylistedVersions: latest.denylistedVersions,
    updatedAt: latest.updatedAt,
  };
}

export const getActivePolicy = query({
  args: {},
  returns: v.union(v.null(), policyValidator),
  handler: async (ctx) => {
    await requireAuthenticated(ctx);
    return await readActivePolicy(ctx);
  },
});

// Internal read for the shared-secret-guarded `/agent-ingest/compatibility-policy`
// route — no Convex user auth (the ingest Worker authenticates with its secret).
export const getActivePolicyInternal = internalQuery({
  args: {},
  returns: v.union(v.null(), policyValidator),
  handler: async (ctx) => {
    return await readActivePolicy(ctx);
  },
});

export const setPolicy = mutation({
  args: {
    minDesktopVersion: v.string(),
    minParserVersion: v.string(),
    denylistedVersions: v.array(v.string()),
  },
  returns: v.id('collectorCompatibilityPolicy'),
  handler: async (ctx, args) => {
    await requireAuthenticated(ctx);
    const user = await requireEnabledUser(ctx);
    if (!user.isAdmin) {
      throw new Error('Admin access required');
    }

    return await ctx.db.insert('collectorCompatibilityPolicy', {
      minDesktopVersion: args.minDesktopVersion,
      minParserVersion: args.minParserVersion,
      denylistedVersions: args.denylistedVersions,
      updatedByUserId: user._id,
      updatedAt: Date.now(),
    });
  },
});
