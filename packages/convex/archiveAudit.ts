import { query } from './_generated/server';
import { v } from 'convex/values';
import { requireAuthenticated } from './auth/auth';
import { requireEnabledUser } from './auth/userHelpers';
import { requireActiveMembership } from './archiveLib';
import { archiveAuditEventValidator } from './validators';

export const listEvents = query({
  args: {},
  returns: v.array(archiveAuditEventValidator),
  handler: async (ctx) => {
    await requireAuthenticated(ctx);
    const user = await requireEnabledUser(ctx);
    if (!user.orgId) throw new Error('No organization found');
    const orgId = user.orgId;
    const org = await ctx.db.get(orgId);
    if (!org || org.deletedAt) throw new Error('Organization not found');
    await requireActiveMembership(ctx, orgId, user._id);

    const rows = await ctx.db
      .query('archiveAuditEvents')
      .withIndex('by_org_occurred_at', (q) => q.eq('orgId', orgId))
      .collect();

    return rows.map((row) => ({
      _id: row._id,
      orgId: row.orgId,
      actorKind: row.actorKind,
      actorUserId: row.actorUserId,
      action: row.action,
      outcome: row.outcome,
      occurredAt: row.occurredAt,
      operationId: row.operationId,
      targetKind: row.targetKind,
      targetId: row.targetId,
      enrollmentId: row.enrollmentId,
      contributionId: row.contributionId,
      activationId: row.activationId,
      source: row.source,
      sourceSessionId: row.sourceSessionId,
      relevantCount: row.relevantCount,
      manifestRootHash: row.manifestRootHash,
    }));
  },
});
