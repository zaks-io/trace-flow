import { query } from './_generated/server';
import { v } from 'convex/values';
import { requireAuthenticated } from './auth/auth';
import { requireEnabledUser } from './auth/userHelpers';
import { requireActiveMembership } from './archiveLib';
import { isArchiveAuditEventVisibleToMember } from './archiveAuditLib';
import { archiveAuditEventValidator } from './validators';
import type { Doc, Id } from './_generated/dataModel';

function projectAuditEvent(row: Doc<'archiveAuditEvents'>) {
  return {
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
  };
}

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
    const membership = await requireActiveMembership(ctx, orgId, user._id);
    const isOwner = org.ownerId === user._id && membership.role === 'owner';

    const rows = await ctx.db
      .query('archiveAuditEvents')
      .withIndex('by_org_occurred_at', (q) => q.eq('orgId', orgId))
      .collect();

    if (isOwner) {
      return rows.map(projectAuditEvent);
    }

    const enrollmentOwners = new Map<Id<'archiveEnrollments'>, Id<'users'>>();
    const contributionOwners = new Map<Id<'archiveContributions'>, Id<'users'>>();
    const visible = [];
    for (const row of rows) {
      let enrollmentUserId: Id<'users'> | undefined;
      if (row.enrollmentId) {
        const cached = enrollmentOwners.get(row.enrollmentId);
        if (cached) {
          enrollmentUserId = cached;
        } else {
          const enrollment = await ctx.db.get(row.enrollmentId);
          if (enrollment) {
            enrollmentOwners.set(row.enrollmentId, enrollment.userId);
            enrollmentUserId = enrollment.userId;
          }
        }
      }
      let contributionUserId: Id<'users'> | undefined;
      if (row.contributionId) {
        const cached = contributionOwners.get(row.contributionId);
        if (cached) {
          contributionUserId = cached;
        } else {
          const contribution = await ctx.db.get(row.contributionId);
          if (contribution) {
            contributionOwners.set(row.contributionId, contribution.userId);
            contributionUserId = contribution.userId;
          }
        }
      }
      if (
        isArchiveAuditEventVisibleToMember({
          viewerUserId: user._id,
          actorUserId: row.actorUserId,
          enrollmentUserId,
          contributionUserId,
        })
      ) {
        visible.push(projectAuditEvent(row));
      }
    }
    return visible;
  },
});
