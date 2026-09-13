import { v } from 'convex/values';
import { internalMutation, internalQuery } from './_generated/server';

/** Include empty organizations: acknowledged Queue work need not have reached Tinybird yet. */
export const listOrganizations = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: v.object({
    organizations: v.array(v.string()),
    continueCursor: v.string(),
    isDone: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query('organizations')
      .paginate({ cursor: args.cursor, numItems: 100 });
    return {
      organizations: result.page
        .filter((org) => org.deletedAt === undefined && org.deletionStartedAt === undefined)
        .map((org) => org._id),
      continueCursor: result.continueCursor,
      isDone: result.isDone,
    };
  },
});

// The lock has no timeout because an uncertain Copy request can still write after its caller exits.
export const begin = internalMutation({
  args: { orgId: v.id('organizations'), migrationId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    if (args.migrationId !== 'bounded-agent-ingestion-v1')
      throw new Error('Invalid ingestion migration');
    const org = await ctx.db.get(args.orgId);
    if (!org || org.deletedAt !== undefined || org.deletionStartedAt !== undefined) return false;
    if (
      org.agentIngestionMigrationId !== undefined &&
      org.agentIngestionMigrationId !== args.migrationId
    ) {
      throw new Error('Conflicting organization ingestion migration');
    }
    await ctx.db.patch(args.orgId, { agentIngestionMigrationId: args.migrationId });
    return true;
  },
});

export const complete = internalMutation({
  args: { orgId: v.id('organizations'), migrationId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const org = await ctx.db.get(args.orgId);
    if (!org) throw new Error('Organization not found');
    if (org.agentIngestionMigrationId === undefined) return null;
    if (org.agentIngestionMigrationId !== args.migrationId)
      throw new Error('Organization ingestion migration lock mismatch');
    await ctx.db.patch(args.orgId, { agentIngestionMigrationId: undefined });
    return null;
  },
});
