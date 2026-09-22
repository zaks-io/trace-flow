import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';

export const removeCollectorCredentialExpiry = internalMutation({
  args: {},
  returns: v.object({ scanned: v.number(), migrated: v.number() }),
  handler: async (ctx) => {
    const credentials = await ctx.db.query('collectorCredentials').collect();
    let migrated = 0;

    for (const credential of credentials) {
      if (credential.expiresAt === undefined) continue;

      await ctx.db.patch(credential._id, { expiresAt: undefined });
      await ctx.scheduler.runAfter(0, internal.integrations.cloudflare.syncCollectorCredToKV, {
        hashedSecret: credential.hashedSecret,
        orgId: credential.orgId,
        userId: credential.userId,
        collectorId: credential.collectorId,
        status: credential.status,
        createdAt: credential._creationTime,
      });
      migrated += 1;
    }

    return { scanned: credentials.length, migrated };
  },
});
