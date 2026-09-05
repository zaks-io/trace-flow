import type { HonoWithConvex } from 'convex-helpers/server/hono';
import type { ActionCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { getRequestLogger, hasValidBearerSecret, isConvexDocumentId } from './shared';

export function registerArchiveKeyRoutes(app: HonoWithConvex<ActionCtx>): void {
  // Archive API receives only the wrapped organization key. The Worker unwraps
  // it with its deployment secret immediately before encrypting an object.
  app.post('/archive-api/key', async (c) => {
    const logger = getRequestLogger(c.req.raw, { operation: 'archive_key' });
    const authHeader = c.req.header('Authorization');
    const secret = process.env.ARCHIVE_API_SHARED_SECRET;
    if (!hasValidBearerSecret(authHeader, secret)) {
      logger.warn('convex.archive_key_shared_secret_invalid', {
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

    let body: { orgId?: string; keyVersion?: number };
    try {
      body = await c.req.json<{ orgId?: string; keyVersion?: number }>();
    } catch {
      logger.warn('convex.archive_key_request_invalid', { reason: 'invalid_json' });
      await logger.flush();
      return c.json({ error: 'Invalid request' }, 400);
    }
    if (!isConvexDocumentId(body.orgId)) {
      logger.warn('convex.archive_key_request_invalid', { reason: 'invalid_organization_id' });
      await logger.flush();
      return c.json({ error: 'Invalid organization id' }, 400);
    }
    const keyVersion = body.keyVersion;
    if (typeof keyVersion !== 'number' || !Number.isSafeInteger(keyVersion) || keyVersion < 1) {
      logger.warn('convex.archive_key_request_invalid', { reason: 'invalid_key_version' });
      await logger.flush();
      return c.json({ error: 'Invalid key version' }, 400);
    }

    let version: { keyVersion: number; wrappedKey: string } | null;
    try {
      version = await c.env.runQuery(internal.archiveKeysInternal.getVersion, {
        orgId: body.orgId as Id<'organizations'>,
        keyVersion,
      });
    } catch (error) {
      logger.error('convex.archive_key_lookup_failed', error, { error_class: 'query_failed' });
      await logger.flush();
      return c.json({ error: 'Archive key unavailable' }, 503);
    }
    if (!version) {
      logger.warn('convex.archive_key_unavailable');
      await logger.flush();
      return c.json({ error: 'Archive key unavailable' }, 404);
    }
    logger.info('convex.archive_key_retrieved', { key_version: keyVersion });
    await logger.flush();
    return c.json({ keyVersion: version.keyVersion, wrappedKey: version.wrappedKey });
  });
}
