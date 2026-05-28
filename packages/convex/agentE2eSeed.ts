import { internalMutation } from './_generated/server';
import { v } from 'convex/values';

// Dev-only seed for the headless collector E2E (3d). Internal, so it is never client-exposed;
// drive it with `bunx convex run agentE2eSeed:seedDevCollector`. It returns a real org + a user
// that belongs to it, because the ingest Worker's claim-sessions route validates both
// (`getByIdInternal` + `user.orgId === orgId`) and a throwaway id 404s. It also ensures a
// permissive compatibility policy exists so the version gate accepts the `e2e` sentinel versions
// the harness sends (they parse to 0.0.0). Not part of the product surface; safe to delete.
export const seedDevCollector = internalMutation({
  args: {},
  returns: v.object({
    orgId: v.id('organizations'),
    userId: v.id('users'),
    collectorId: v.string(),
  }),
  handler: async (ctx) => {
    const org = await ctx.db.query('organizations').first();
    if (!org) {
      throw new Error('no organization in dev Convex; sign in to the dev web app first');
    }

    // by_org_id guarantees the returned user has `orgId === org._id`, which is exactly the
    // membership claim-sessions checks. Owner ids can lag a user's orgId, so query members directly.
    const user = await ctx.db
      .query('users')
      .withIndex('by_org_id', (q) => q.eq('orgId', org._id))
      .first();
    if (!user) {
      throw new Error(`no user with orgId=${org._id}; complete dev onboarding first`);
    }

    const policy = await ctx.db
      .query('collectorCompatibilityPolicy')
      .withIndex('by_updated_at')
      .order('desc')
      .first();
    if (!policy) {
      await ctx.db.insert('collectorCompatibilityPolicy', {
        minDesktopVersion: '0.0.0',
        minParserVersion: '0.0.0',
        denylistedVersions: [],
        updatedByUserId: user._id,
        updatedAt: Date.now(),
      });
    }

    return { orgId: org._id, userId: user._id, collectorId: 'e2e-collector' };
  },
});
