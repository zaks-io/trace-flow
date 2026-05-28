import { internalMutation } from './_generated/server';
import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';

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

/**
 * Batched first-writer claim: resolve many `session_pk`s in ONE mutation instead of one mutation per
 * session. A multi-session ingest envelope (the collector batches its backfill) would otherwise pay a
 * separate Convex round-trip + OCC transaction per session, serializing the whole batch behind the
 * control plane. Here every claim commits in a single transaction; OCC still guarantees first-writer
 * per `(orgId, session_pk)` across concurrent batches, and a duplicate `session_pk` within the same
 * request is deduped so we never attempt two inserts for one key in one transaction.
 *
 * Returns one result per DISTINCT input `session_pk`; the caller maps statuses back by `sessionPk`.
 */
export const claimSessionsBatch = internalMutation({
  args: {
    orgId: v.id('organizations'),
    sessionPks: v.array(v.string()),
    userId: v.id('users'),
    collectorId: v.string(),
  },
  returns: v.array(
    v.object({
      sessionPk: v.string(),
      status: claimStatusValidator,
      ownerUserId: v.id('users'),
    }),
  ),
  handler: async (ctx, args) => {
    const now = Date.now();
    const results: { sessionPk: string; status: ClaimStatus; ownerUserId: Id<'users'> }[] = [];
    // Dedup within the request: the same session can appear across multiple files/cursors in one
    // batch, and inserting it twice in one transaction would create two owner rows.
    const seen = new Set<string>();

    for (const sessionPk of args.sessionPks) {
      if (seen.has(sessionPk)) continue;
      seen.add(sessionPk);

      const existing = await ctx.db
        .query('agentSessionOwners')
        .withIndex('by_org_session', (q) => q.eq('orgId', args.orgId).eq('sessionPk', sessionPk))
        .unique();

      if (!existing) {
        await ctx.db.insert('agentSessionOwners', {
          orgId: args.orgId,
          sessionPk,
          userId: args.userId,
          collectorId: args.collectorId,
          claimedAt: now,
        });
        results.push({ sessionPk, status: 'claimed', ownerUserId: args.userId });
        continue;
      }

      results.push({
        sessionPk,
        status: decideClaim(existing.userId, args.userId),
        ownerUserId: existing.userId,
      });
    }

    return results;
  },
});
