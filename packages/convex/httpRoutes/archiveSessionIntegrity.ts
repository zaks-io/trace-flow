import type { HonoWithConvex } from 'convex-helpers/server/hono';
import {
  isArchiveCanonicalIdentifier,
  isArchiveIntegrityErrorClass,
  type ArchiveIntegrityErrorClass,
} from '@trace-flow/types';
import type { ActionCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { getRequestLogger, hasValidBearerSecret, isConvexDocumentId } from './shared';

export function registerArchiveSessionIntegrityRoutes(app: HonoWithConvex<ActionCtx>): void {
  app.post('/archive-api/session-integrity', async (c) => {
    const logger = getRequestLogger(c.req.raw, { operation: 'archive_session_integrity_apply' });
    if (
      !hasValidBearerSecret(c.req.header('Authorization'), process.env.ARCHIVE_API_SHARED_SECRET)
    ) {
      logger.warn('convex.archive_session_integrity_shared_secret_invalid');
      await logger.flush();
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: Record<string, unknown>;
    try {
      const parsed: unknown = await c.req.json();
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('invalid_json');
      }
      body = parsed as Record<string, unknown>;
    } catch {
      logger.warn('convex.archive_session_integrity_request_invalid');
      await logger.flush();
      return c.json({ error: 'Invalid session integrity update' }, 400);
    }
    if (
      (body.source !== 'claude' && body.source !== 'codex') ||
      !isArchiveCanonicalIdentifier(body.sourceSessionId)
    ) {
      logger.warn('convex.archive_session_integrity_request_invalid');
      await logger.flush();
      return c.json({ error: 'Invalid session integrity update' }, 400);
    }

    const isRepair = body.repairOutcome === 'failure' || body.repairOutcome === 'success';
    const validBinding = isRepair
      ? isConvexDocumentId(body.contributionId) &&
        isConvexDocumentId(body.orgId) &&
        isConvexDocumentId(body.userId) &&
        body.collectorCredentialId === undefined &&
        body.errorClass === undefined
      : isConvexDocumentId(body.collectorCredentialId) &&
        isArchiveIntegrityErrorClass(body.errorClass) &&
        body.contributionId === undefined &&
        body.orgId === undefined &&
        body.userId === undefined &&
        body.repairOutcome === undefined;
    if (!validBinding) {
      logger.warn('convex.archive_session_integrity_request_invalid');
      await logger.flush();
      return c.json({ error: 'Invalid session integrity update' }, 400);
    }
    const source = body.source;
    const sourceSessionId = body.sourceSessionId;

    try {
      if (isRepair) {
        const result = await c.env.runMutation(internal.archiveInternal.applySessionRepairOutcome, {
          contributionId: body.contributionId as Id<'archiveContributions'>,
          expectedOrgId: body.orgId as Id<'organizations'>,
          expectedUserId: body.userId as Id<'users'>,
          source,
          sourceSessionId,
          repairOutcome: body.repairOutcome as 'failure' | 'success',
        });
        logger.info('convex.archive_session_integrity_repair_applied', {
          repairOutcome: body.repairOutcome,
        });
        await logger.flush();
        return c.json(result);
      }
      const result = await c.env.runMutation(internal.archiveInternal.upsertSessionIntegrity, {
        collectorCredentialId: body.collectorCredentialId as Id<'collectorCredentials'>,
        source,
        sourceSessionId,
        errorClass: body.errorClass as ArchiveIntegrityErrorClass,
      });
      logger.info('convex.archive_session_integrity_applied');
      await logger.flush();
      return c.json(result);
    } catch (error) {
      logger.error('convex.archive_session_integrity_failed', error);
      await logger.flush();
      return c.json({ error: 'Session integrity update failed' }, 500);
    }
  });
}
