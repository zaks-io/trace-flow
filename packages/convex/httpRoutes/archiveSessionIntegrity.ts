import type { HonoWithConvex } from 'convex-helpers/server/hono';
import type { ActionCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { getRequestLogger, hasValidBearerSecret, isConvexDocumentId } from './shared';

function isMetadataString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 1024 &&
    !value.includes('/') &&
    !value.includes('\\')
  );
}

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
      !isConvexDocumentId(body.collectorCredentialId) ||
      (body.source !== 'claude' && body.source !== 'codex') ||
      !isMetadataString(body.sourceSessionId) ||
      !isMetadataString(body.errorClass)
    ) {
      logger.warn('convex.archive_session_integrity_request_invalid');
      await logger.flush();
      return c.json({ error: 'Invalid session integrity update' }, 400);
    }

    try {
      const result = await c.env.runMutation(internal.archiveInternal.upsertSessionIntegrity, {
        collectorCredentialId: body.collectorCredentialId as Id<'collectorCredentials'>,
        source: body.source,
        sourceSessionId: body.sourceSessionId,
        errorClass: body.errorClass,
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
