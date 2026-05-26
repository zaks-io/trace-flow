import { internalMutation } from './_generated/server';
import { v } from 'convex/values';

// First-writer ownership for an Agent Session within an Organization. The claim
// exists only to protect ingestion ownership and dedupe — it is not a sharing or
// reassignment model. `UserId` stays out of Tinybird row identity.

export const claimStatusValidator = v.union(
  v.literal('claimed'),
  v.literal('owned'),
  v.literal('conflict'),
);

export type ClaimStatus = 'claimed' | 'owned' | 'conflict';

/**
 * First-writer decision table, factored out pure for testing. `null` existing
 * owner → the caller claims; same user → idempotent `owned`; different user →
 * `conflict`. Exported for unit testing.
 */
export function decideClaim(existingUserId: string | null, userId: string): ClaimStatus {
  if (existingUserId === null) return 'claimed';
  return existingUserId === userId ? 'owned' : 'conflict';
}

/**
 * Claim `OrgId + session_pk` for `userId`. Convex OCC makes this a true
 * first-writer guard: two concurrent claims both read the empty `by_org_session`
 * range, but only one insert commits — the loser's read range is invalidated, it
 * retries, sees the committed owner, and resolves to `owned` or `conflict`. No
 * torn state, never two owner rows.
 *
 * - `claimed`: this call created the owner row.
 * - `owned`: already owned by the same user (idempotent re-sync).
 * - `conflict`: owned by a different user → `session_owner_conflict`.
 */
export const claimSession = internalMutation({
  args: {
    orgId: v.id('organizations'),
    sessionPk: v.string(),
    userId: v.id('users'),
    collectorId: v.string(),
  },
  returns: v.object({
    status: claimStatusValidator,
    ownerUserId: v.id('users'),
  }),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('agentSessionOwners')
      .withIndex('by_org_session', (q) => q.eq('orgId', args.orgId).eq('sessionPk', args.sessionPk))
      .unique();

    if (!existing) {
      await ctx.db.insert('agentSessionOwners', {
        orgId: args.orgId,
        sessionPk: args.sessionPk,
        userId: args.userId,
        collectorId: args.collectorId,
        claimedAt: Date.now(),
      });
      return { status: 'claimed' as const, ownerUserId: args.userId };
    }

    return { status: decideClaim(existing.userId, args.userId), ownerUserId: existing.userId };
  },
});
