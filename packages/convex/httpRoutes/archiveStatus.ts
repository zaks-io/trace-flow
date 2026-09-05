import type { HonoWithConvex } from 'convex-helpers/server/hono';
import type { ActionCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { getRequestLogger, hasValidBearerSecret, isConvexDocumentId } from './shared';

const ARCHIVE_STATUS_LIFECYCLES = ['active', 'blocked'] as const;

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isStatusLifecycle(value: unknown): value is (typeof ARCHIVE_STATUS_LIFECYCLES)[number] {
  return (
    typeof value === 'string' &&
    ARCHIVE_STATUS_LIFECYCLES.includes(value as (typeof ARCHIVE_STATUS_LIFECYCLES)[number])
  );
}

export function registerArchiveStatusRoutes(app: HonoWithConvex<ActionCtx>): void {
  app.post('/archive-api/status', async (c) => {
    const logger = getRequestLogger(c.req.raw, { operation: 'archive_status_apply' });
    const authHeader = c.req.header('Authorization');
    const secret = process.env.ARCHIVE_API_SHARED_SECRET;
    if (!hasValidBearerSecret(authHeader, secret)) {
      logger.warn('convex.archive_status_shared_secret_invalid', {
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

    let body: Record<string, unknown>;
    try {
      const parsed: unknown = await c.req.json();
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('non_object_json');
      }
      body = parsed as Record<string, unknown>;
    } catch {
      logger.warn('convex.archive_status_request_invalid', { reason: 'invalid_json' });
      await logger.flush();
      return c.json({ error: 'Invalid status update' }, 400);
    }

    if (!isConvexDocumentId(body.orgId)) {
      logger.warn('convex.archive_status_request_invalid', { reason: 'invalid_organization_id' });
      await logger.flush();
      return c.json({ error: 'Invalid organization id' }, 400);
    }
    if (!isSafeNonNegativeInteger(body.revision) || body.revision === 0) {
      logger.warn('convex.archive_status_request_invalid', { reason: 'invalid_revision' });
      await logger.flush();
      return c.json({ error: 'Invalid revision' }, 400);
    }
    if (!isSafeNonNegativeInteger(body.storedBytes)) {
      logger.warn('convex.archive_status_request_invalid', { reason: 'invalid_stored_bytes' });
      await logger.flush();
      return c.json({ error: 'Invalid stored bytes' }, 400);
    }
    if (
      body.lastDurableAcknowledgedAt !== undefined &&
      !isSafeNonNegativeInteger(body.lastDurableAcknowledgedAt)
    ) {
      logger.warn('convex.archive_status_request_invalid', {
        reason: 'invalid_acknowledgement_timestamp',
      });
      await logger.flush();
      return c.json({ error: 'Invalid acknowledgement timestamp' }, 400);
    }
    if (body.lifecycle !== undefined && !isStatusLifecycle(body.lifecycle)) {
      logger.warn('convex.archive_status_request_invalid', { reason: 'invalid_lifecycle' });
      await logger.flush();
      return c.json({ error: 'Invalid lifecycle' }, 400);
    }

    try {
      const result = await c.env.runMutation(
        internal.archiveInternal.applyServerStatusByOrganization,
        {
          orgId: body.orgId as Id<'organizations'>,
          revision: body.revision,
          storedBytes: body.storedBytes,
          lastDurableAcknowledgedAt: body.lastDurableAcknowledgedAt,
          lifecycle: body.lifecycle,
        },
      );
      logger.info('convex.archive_status_applied', { replay: result.replay });
      await logger.flush();
      return c.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Archive status update failed';
      const conflict =
        message.includes('Stale archive server status revision') ||
        message.includes('Archive server status revision was reused');
      if (conflict) {
        logger.warn('convex.archive_status_conflict', { reason: 'revision_conflict' });
        await logger.flush();
        return c.json({ error: 'Archive status revision conflict' }, 409);
      }
      logger.error('convex.archive_status_failed', error, { error_class: 'mutation_failed' });
      await logger.flush();
      return c.json({ error: 'Archive status update failed' }, 500);
    }
  });
}
