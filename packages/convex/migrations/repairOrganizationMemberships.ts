import { paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';

export const repairOrganizationMemberships = internalMutation({
  args: {
    table: v.union(
      v.literal('users'),
      v.literal('organizationMembers'),
      v.literal('organizations'),
    ),
    dryRun: v.optional(v.boolean()),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({
    scanned: v.number(),
    ownerRolesToRepair: v.number(),
    nonOwnerRolesToRepair: v.number(),
    ownerMembershipsToCreate: v.number(),
    usersWithoutActiveMembership: v.number(),
    missingOwnerUsers: v.number(),
    orphanMemberships: v.number(),
    continueCursor: v.string(),
    isDone: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const { numItems } = args.paginationOpts;
    if (!Number.isInteger(numItems) || numItems < 1 || numItems > 100) {
      throw new Error('Migration page size must be between 1 and 100');
    }
    const dryRun = args.dryRun ?? true;
    const counts = {
      scanned: 0,
      ownerRolesToRepair: 0,
      nonOwnerRolesToRepair: 0,
      ownerMembershipsToCreate: 0,
      usersWithoutActiveMembership: 0,
      missingOwnerUsers: 0,
      orphanMemberships: 0,
    };

    if (args.table === 'users') {
      const result = await ctx.db.query('users').paginate(args.paginationOpts);
      for (const user of result.page) {
        if (!user.orgId) continue;
        const active = await ctx.db
          .query('organizationMembers')
          .withIndex('by_user_id', (q) => q.eq('userId', user._id))
          .filter((q) =>
            q.and(q.eq(q.field('orgId'), user.orgId), q.eq(q.field('status'), 'active')),
          )
          .first();
        if (!active) counts.usersWithoutActiveMembership++;
      }
      return {
        ...counts,
        scanned: result.page.length,
        continueCursor: result.continueCursor,
        isDone: result.isDone,
      };
    }

    if (args.table === 'organizationMembers') {
      const result = await ctx.db.query('organizationMembers').paginate(args.paginationOpts);
      for (const member of result.page) {
        const org = await ctx.db.get(member.orgId);
        if (!org) {
          counts.orphanMemberships++;
          continue;
        }
        const role = member.userId === org.ownerId ? 'owner' : 'member';
        if (member.role === role) continue;
        if (role === 'owner') counts.ownerRolesToRepair++;
        else counts.nonOwnerRolesToRepair++;
        if (!dryRun) await ctx.db.patch(member._id, { role });
      }
      return {
        ...counts,
        scanned: result.page.length,
        continueCursor: result.continueCursor,
        isDone: result.isDone,
      };
    }

    const result = await ctx.db.query('organizations').paginate(args.paginationOpts);
    for (const org of result.page) {
      const owner = await ctx.db.get(org.ownerId);
      if (!owner) {
        counts.missingOwnerUsers++;
        continue;
      }
      const membership = await ctx.db
        .query('organizationMembers')
        .withIndex('by_user_id', (q) => q.eq('userId', org.ownerId))
        .filter((q) => q.eq(q.field('orgId'), org._id))
        .first();
      if (membership) continue;
      counts.ownerMembershipsToCreate++;
      if (!dryRun) {
        await ctx.db.insert('organizationMembers', {
          orgId: org._id,
          userId: org.ownerId,
          role: 'owner',
          status: 'active',
          joinedAt: Date.now(),
        });
      }
    }
    return {
      ...counts,
      scanned: result.page.length,
      continueCursor: result.continueCursor,
      isDone: result.isDone,
    };
  },
});
