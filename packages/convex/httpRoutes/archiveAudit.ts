import type { HonoWithConvex } from 'convex-helpers/server/hono';
import { traceContextFromHeaders } from '@trace-flow/logging';
import type { ActionCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { serializeArchiveApiAuditInput } from '../archiveAuditLib';
import { getRequestLogger, hasValidBearerSecret, isConvexDocumentId } from './shared';

export function registerArchiveAuditRoutes(app: HonoWithConvex<ActionCtx>): void {
  // Archive API: Worker appends a metadata-only semantic audit event. Actor,
  // Organization, and server time are derived here — never trusted from the body.
  app.post('/archive-api/audit-events', async (c) => {
    const ctx = c.env;
    const requestTraceContext = traceContextFromHeaders(c.req.raw.headers);

    const authHeader = c.req.header('Authorization');
    const secret = process.env.ARCHIVE_API_SHARED_SECRET;
    if (!hasValidBearerSecret(authHeader, secret)) {
      const logger = getRequestLogger(c.req.raw, {
        operation: 'archive_audit_append',
        ...requestTraceContext,
      });
      logger.warn('convex.archive_audit_shared_secret_invalid', {
        reason:
          secret === undefined || secret.length === 0
            ? 'missing_configured_secret'
            : authHeader === undefined
              ? 'missing'
              : 'invalid',
      });
      await logger.flush();
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const logger = getRequestLogger(c.req.raw, {
      operation: 'archive_audit_append',
      ...requestTraceContext,
    });

    let body: Record<string, unknown>;
    try {
      const parsed: unknown = await c.req.json();
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        logger.warn('convex.archive_audit_rejected', { reason: 'non_object_json' });
        await logger.flush();
        return c.json({ error: 'Invalid audit event' }, 400);
      }
      body = parsed as Record<string, unknown>;
    } catch {
      logger.warn('convex.archive_audit_rejected', { reason: 'malformed_json' });
      await logger.flush();
      return c.json({ error: 'Invalid audit event' }, 400);
    }

    let serialized: ReturnType<typeof serializeArchiveApiAuditInput>;
    try {
      serialized = serializeArchiveApiAuditInput(body);
    } catch (error) {
      logger.warn('convex.archive_audit_rejected', {
        reason: error instanceof Error ? error.message : 'invalid',
      });
      await logger.flush();
      return c.json({ error: error instanceof Error ? error.message : 'Invalid audit event' }, 400);
    }

    const binding = serialized.binding;
    const kind = binding.kind;
    if (
      kind !== 'activation' &&
      kind !== 'enrollment' &&
      kind !== 'contribution' &&
      kind !== 'collector_credential'
    ) {
      logger.warn('convex.archive_audit_binding_invalid');
      await logger.flush();
      return c.json({ error: 'Invalid audit binding' }, 400);
    }

    const activationId = binding.activationId;
    const enrollmentId = binding.enrollmentId;
    const contributionId = binding.contributionId;
    const collectorCredentialId = binding.collectorCredentialId;
    if (kind === 'activation' && !isConvexDocumentId(activationId)) {
      logger.warn('convex.archive_audit_activation_id_invalid');
      await logger.flush();
      return c.json({ error: 'Invalid activation id' }, 400);
    }
    if (kind === 'enrollment' && !isConvexDocumentId(enrollmentId)) {
      logger.warn('convex.archive_audit_enrollment_id_invalid');
      await logger.flush();
      return c.json({ error: 'Invalid enrollment id' }, 400);
    }
    if (kind === 'contribution' && !isConvexDocumentId(contributionId)) {
      logger.warn('convex.archive_audit_contribution_id_invalid');
      await logger.flush();
      return c.json({ error: 'Invalid contribution id' }, 400);
    }
    if (kind === 'collector_credential' && !isConvexDocumentId(collectorCredentialId)) {
      logger.warn('convex.archive_audit_credential_id_invalid');
      await logger.flush();
      return c.json({ error: 'Invalid collector credential id' }, 400);
    }
    if (serialized.expectedOrgId !== undefined && !isConvexDocumentId(serialized.expectedOrgId)) {
      logger.warn('convex.archive_audit_expected_org_id_invalid');
      await logger.flush();
      return c.json({ error: 'Invalid organization id' }, 400);
    }

    const resolvedBinding =
      kind === 'activation'
        ? {
            kind: 'activation' as const,
            activationId: activationId as Id<'archiveActivations'>,
          }
        : kind === 'enrollment'
          ? {
              kind: 'enrollment' as const,
              enrollmentId: enrollmentId as Id<'archiveEnrollments'>,
            }
          : kind === 'contribution'
            ? {
                kind: 'contribution' as const,
                contributionId: contributionId as Id<'archiveContributions'>,
              }
            : {
                kind: 'collector_credential' as const,
                collectorCredentialId: collectorCredentialId as Id<'collectorCredentials'>,
              };

    try {
      const result = await ctx.runMutation(internal.archiveAuditInternal.appendSemanticEvent, {
        binding: resolvedBinding,
        expectedOrgId: serialized.expectedOrgId as Id<'organizations'> | undefined,
        action: serialized.action,
        outcome: serialized.outcome,
        operationId: serialized.operationId,
        targetKind: serialized.targetKind,
        targetId: serialized.targetId,
        relevantCount: serialized.relevantCount,
        manifestRootHash: serialized.manifestRootHash,
        source: serialized.source,
        sourceSessionId: serialized.sourceSessionId,
      });
      logger.info('convex.archive_audit_appended', {
        created: result.created,
        action: serialized.action,
        outcome: serialized.outcome,
      });
      await logger.flush();
      return c.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid audit event';
      if (message.includes('substitution') || message.includes('not found')) {
        logger.warn('convex.archive_audit_rejected', { reason: message });
        await logger.flush();
        return c.json({ error: message }, 400);
      }
      logger.error('convex.archive_audit_failed', error);
      await logger.flush();
      return c.json({ error: 'Failed to append audit event' }, 500);
    }
  });
}
