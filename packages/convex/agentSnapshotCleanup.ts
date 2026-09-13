import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalAction, internalMutation, internalQuery } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { cleanupAgentSnapshots } from './agentSnapshotCleanupLib';

const cleanupRef = makeFunctionReference<'action', { orgId: Id<'organizations'> }, null>(
  'agentSnapshotCleanup:cleanup',
);
const schedulePageRef = makeFunctionReference<'mutation', { cursor?: string | null }, null>(
  'agentSnapshotCleanup:schedulePage',
);
const statusRef = makeFunctionReference<
  'query',
  { orgId: Id<'organizations'> },
  { fingerprint?: string; completedAt?: number } | null
>('agentSnapshotCleanup:status');
const completedRef = makeFunctionReference<
  'mutation',
  { orgId: Id<'organizations'>; fingerprint: string },
  null
>('agentSnapshotCleanup:completed');

export { schedulePageRef as scheduleAgentSnapshotCleanup };

export const schedulePage = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query('organizations')
      .paginate({ cursor: args.cursor ?? null, numItems: 20 });
    for (let index = 0; index < page.page.length; index++) {
      const org = page.page[index]!;
      if (org.deletedAt === undefined && org.deletionStartedAt === undefined) {
        await ctx.scheduler.runAfter(index * 10_000, cleanupRef, { orgId: org._id });
      }
    }
    if (!page.isDone)
      await ctx.scheduler.runAfter(200_000, schedulePageRef, { cursor: page.continueCursor });
    return null;
  },
});

export const status = internalQuery({
  args: { orgId: v.id('organizations') },
  returns: v.union(
    v.null(),
    v.object({ fingerprint: v.optional(v.string()), completedAt: v.optional(v.number()) }),
  ),
  handler: async (ctx, args) => {
    const org = await ctx.db.get(args.orgId);
    if (!org || org.deletedAt !== undefined || org.deletionStartedAt !== undefined) return null;
    return {
      fingerprint: org.agentSnapshotCleanupFingerprint,
      completedAt: org.agentSnapshotCleanupAt,
    };
  },
});

export const completed = internalMutation({
  args: { orgId: v.id('organizations'), fingerprint: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const org = await ctx.db.get(args.orgId);
    if (org && org.deletedAt === undefined && org.deletionStartedAt === undefined) {
      await ctx.db.patch(args.orgId, {
        agentSnapshotCleanupFingerprint: args.fingerprint,
        agentSnapshotCleanupAt: Date.now(),
      });
    }
    return null;
  },
});

export const cleanup = internalAction({
  args: { orgId: v.id('organizations') },
  returns: v.null(),
  handler: async (ctx, args) => {
    const current = await ctx.runQuery(statusRef, args);
    if (!current) return null;
    const token = process.env.TINYBIRD_ADMIN_TOKEN;
    const host = process.env.TINYBIRD_API_URL;
    if (!token || !host) throw new Error('Tinybird snapshot cleanup configuration is missing');
    const fingerprint = await cleanupAgentSnapshots(
      {
        TINYBIRD_HOST: host,
        TINYBIRD_AGENT_SNAPSHOT_TOKEN: token,
        TINYBIRD_AGENT_SNAPSHOT_CLEANUP_TOKEN: token,
      },
      args.orgId,
      current.fingerprint,
      current.completedAt,
    );
    if (fingerprint !== null)
      await ctx.runMutation(completedRef, { orgId: args.orgId, fingerprint });
    return null;
  },
});
