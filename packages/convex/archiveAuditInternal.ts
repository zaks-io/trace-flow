import { internalMutation, internalQuery } from './_generated/server';
import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import { actorKindForApiAction, appendArchiveAuditEvent } from './archiveAuditLib';
import {
  archiveApiAuditActionValidator,
  archiveAuditAppendResultValidator,
  archiveAuditBindingValidator,
  archiveAuditEventValidator,
  archiveAuditOutcomeValidator,
  archiveAuditTargetKindValidator,
  archiveSupportedSourceValidator,
} from './validators';

async function resolveAuditBinding(
  ctx: Parameters<typeof appendArchiveAuditEvent>[0],
  binding: {
    kind: 'activation' | 'enrollment' | 'contribution' | 'collector_credential';
    activationId?: Id<'archiveActivations'>;
    enrollmentId?: Id<'archiveEnrollments'>;
    contributionId?: Id<'archiveContributions'>;
    collectorCredentialId?: Id<'collectorCredentials'>;
  },
): Promise<{
  orgId: Id<'organizations'>;
  activationId?: Id<'archiveActivations'>;
  enrollmentId?: Id<'archiveEnrollments'>;
  contributionId?: Id<'archiveContributions'>;
}> {
  if (binding.kind === 'activation' && binding.activationId) {
    const activation = await ctx.db.get(binding.activationId);
    if (!activation) throw new Error('Archive activation not found');
    return { orgId: activation.orgId, activationId: activation._id };
  }
  if (binding.kind === 'enrollment' && binding.enrollmentId) {
    const enrollment = await ctx.db.get(binding.enrollmentId);
    if (!enrollment) throw new Error('Archive enrollment not found');
    return {
      orgId: enrollment.orgId,
      enrollmentId: enrollment._id,
      contributionId: enrollment.contributionId,
    };
  }
  if (binding.kind === 'contribution' && binding.contributionId) {
    const contribution = await ctx.db.get(binding.contributionId);
    if (!contribution) throw new Error('Archive contribution not found');
    return { orgId: contribution.orgId, contributionId: contribution._id };
  }
  if (binding.kind === 'collector_credential' && binding.collectorCredentialId) {
    const credential = await ctx.db.get(binding.collectorCredentialId);
    if (!credential) throw new Error('Collector Credential not found');
    return { orgId: credential.orgId };
  }
  throw new Error('Audit binding is required');
}

export const appendSemanticEvent = internalMutation({
  args: {
    binding: archiveAuditBindingValidator,
    expectedOrgId: v.optional(v.id('organizations')),
    action: archiveApiAuditActionValidator,
    outcome: archiveAuditOutcomeValidator,
    operationId: v.string(),
    targetKind: v.optional(archiveAuditTargetKindValidator),
    targetId: v.optional(v.string()),
    relevantCount: v.optional(v.number()),
    manifestRootHash: v.optional(v.string()),
    source: v.optional(archiveSupportedSourceValidator),
    sourceSessionId: v.optional(v.string()),
  },
  returns: archiveAuditAppendResultValidator,
  handler: async (ctx, args) => {
    const resolved = await resolveAuditBinding(ctx, args.binding);
    if (args.expectedOrgId !== undefined && args.expectedOrgId !== resolved.orgId) {
      throw new Error('Caller-supplied actor or tenant substitution is not allowed');
    }

    return await appendArchiveAuditEvent(ctx, {
      orgId: resolved.orgId,
      actorKind: actorKindForApiAction(args.action),
      action: args.action,
      outcome: args.outcome,
      operationId: args.operationId,
      targetKind: args.targetKind,
      targetId: args.targetId,
      enrollmentId: resolved.enrollmentId,
      contributionId: resolved.contributionId,
      activationId: resolved.activationId,
      source: args.source,
      sourceSessionId: args.sourceSessionId,
      relevantCount: args.relevantCount,
      manifestRootHash: args.manifestRootHash,
    });
  },
});

export const listEventsForOrg = internalQuery({
  args: { orgId: v.id('organizations') },
  returns: v.array(archiveAuditEventValidator),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('archiveAuditEvents')
      .withIndex('by_org_occurred_at', (q) => q.eq('orgId', args.orgId))
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
