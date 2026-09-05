import type { HonoWithConvex } from 'convex-helpers/server/hono';
import type { ActionCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { getRequestLogger, hasValidBearerSecret, isConvexDocumentId } from './shared';

function unauthorizedReason(authHeader: string | undefined, secret: string | undefined): string {
  return secret === undefined || secret.length === 0
    ? 'missing_configured_secret'
    : authHeader === undefined
      ? 'missing'
      : 'invalid';
}

export function registerArchiveKeyRoutes(app: HonoWithConvex<ActionCtx>): void {
  // Archive API receives only the wrapped organization key. The Worker unwraps
  // it with its deployment secret immediately before encrypting an object.
  app.post('/archive-api/key', async (c) => {
    const logger = getRequestLogger(c.req.raw, { operation: 'archive_key' });
    const authHeader = c.req.header('Authorization');
    const secret = process.env.ARCHIVE_API_SHARED_SECRET;
    if (!hasValidBearerSecret(authHeader, secret)) {
      logger.warn('convex.archive_key_shared_secret_invalid', {
        reason: unauthorizedReason(authHeader, secret),
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

  app.post('/archive-api/key/active', async (c) => {
    const logger = getRequestLogger(c.req.raw, { operation: 'archive_key_active' });
    const authHeader = c.req.header('Authorization');
    const secret = process.env.ARCHIVE_API_SHARED_SECRET;
    if (!hasValidBearerSecret(authHeader, secret)) {
      logger.warn('convex.archive_key_shared_secret_invalid', {
        reason: unauthorizedReason(authHeader, secret),
      });
      await logger.flush();
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: { orgId?: string };
    try {
      body = await c.req.json<{ orgId?: string }>();
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

    try {
      const version = await c.env.runQuery(internal.archiveKeysInternal.getActiveVersion, {
        orgId: body.orgId as Id<'organizations'>,
      });
      if (!version) {
        logger.warn('convex.archive_active_key_unavailable');
        await logger.flush();
        return c.json({ error: 'Archive key unavailable' }, 404);
      }
      logger.info('convex.archive_active_key_retrieved', { key_version: version.keyVersion });
      await logger.flush();
      return c.json({
        keyVersion: version.keyVersion,
        wrappedKey: version.wrappedKey,
        retiringKeyVersion: version.retiringKeyVersion,
        rotationOperationId: version.rotationOperationId,
        rotationStatus: version.rotationStatus,
      });
    } catch (error) {
      logger.error('convex.archive_key_lookup_failed', error, { error_class: 'query_failed' });
      await logger.flush();
      return c.json({ error: 'Archive key unavailable' }, 503);
    }
  });

  app.post('/archive-api/key/activate', async (c) => {
    const logger = getRequestLogger(c.req.raw, { operation: 'archive_key_activate' });
    const authHeader = c.req.header('Authorization');
    const secret = process.env.ARCHIVE_API_SHARED_SECRET;
    if (!hasValidBearerSecret(authHeader, secret)) {
      logger.warn('convex.archive_key_shared_secret_invalid', {
        reason: unauthorizedReason(authHeader, secret),
      });
      await logger.flush();
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: {
      orgId?: string;
      keyVersion?: number;
      wrappedKey?: string;
      operationId?: string;
    };
    try {
      body = await c.req.json();
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
    if (
      typeof body.keyVersion !== 'number' ||
      !Number.isSafeInteger(body.keyVersion) ||
      body.keyVersion < 1 ||
      typeof body.wrappedKey !== 'string' ||
      typeof body.operationId !== 'string' ||
      body.operationId.length === 0
    ) {
      logger.warn('convex.archive_key_request_invalid', { reason: 'invalid_activation' });
      await logger.flush();
      return c.json({ error: 'Invalid request' }, 400);
    }

    try {
      const result = await c.env.runMutation(internal.archiveKeysInternal.activateVersion, {
        orgId: body.orgId as Id<'organizations'>,
        keyVersion: body.keyVersion,
        wrappedKey: body.wrappedKey,
        operationId: body.operationId,
      });
      logger.info('convex.archive_key_activated', {
        key_version: result.toVersion,
        replay: result.replay,
      });
      await logger.flush();
      return c.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Archive key activation failed';
      if (
        message.includes('already') ||
        message.includes('increment') ||
        message.includes('initialized') ||
        message.includes('invalid') ||
        message.includes('not found') ||
        message.includes('failed')
      ) {
        logger.warn('convex.archive_key_activation_rejected', { reason: message });
        await logger.flush();
        return c.json({ error: message }, 409);
      }
      logger.error('convex.archive_key_activation_failed', error, {
        error_class: 'mutation_failed',
      });
      await logger.flush();
      return c.json({ error: 'Archive key activation failed' }, 503);
    }
  });

  app.post('/archive-api/key/destroy-retiring', async (c) => {
    const logger = getRequestLogger(c.req.raw, { operation: 'archive_key_destroy_retiring' });
    const authHeader = c.req.header('Authorization');
    const secret = process.env.ARCHIVE_API_SHARED_SECRET;
    if (!hasValidBearerSecret(authHeader, secret)) {
      logger.warn('convex.archive_key_shared_secret_invalid', {
        reason: unauthorizedReason(authHeader, secret),
      });
      await logger.flush();
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: {
      orgId?: string;
      keyVersion?: number;
      operationId?: string;
      liveReferenceCount?: number;
    };
    try {
      body = await c.req.json();
    } catch {
      logger.warn('convex.archive_key_request_invalid', { reason: 'invalid_json' });
      await logger.flush();
      return c.json({ error: 'Invalid request' }, 400);
    }
    if (
      !isConvexDocumentId(body.orgId) ||
      typeof body.keyVersion !== 'number' ||
      !Number.isSafeInteger(body.keyVersion) ||
      body.keyVersion < 1 ||
      typeof body.operationId !== 'string' ||
      body.operationId.length === 0 ||
      typeof body.liveReferenceCount !== 'number' ||
      !Number.isSafeInteger(body.liveReferenceCount) ||
      body.liveReferenceCount < 0
    ) {
      logger.warn('convex.archive_key_request_invalid', { reason: 'invalid_destroy' });
      await logger.flush();
      return c.json({ error: 'Invalid request' }, 400);
    }

    try {
      const destroyed = await c.env.runMutation(
        internal.archiveKeysInternal.destroyRetiringVersion,
        {
          orgId: body.orgId as Id<'organizations'>,
          keyVersion: body.keyVersion,
          operationId: body.operationId,
          liveReferenceCount: body.liveReferenceCount,
        },
      );
      logger.info('convex.archive_retiring_key_destroyed', {
        key_version: body.keyVersion,
        destroyed,
        live_references: body.liveReferenceCount,
      });
      await logger.flush();
      return c.json({ destroyed });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Archive key destroy failed';
      if (
        message.includes('live object references') ||
        message.includes('cannot be destroyed') ||
        message.includes('does not match') ||
        message.includes('not initialized')
      ) {
        logger.warn('convex.archive_key_destroy_rejected', { reason: message });
        await logger.flush();
        return c.json({ error: message }, 409);
      }
      logger.error('convex.archive_key_destroy_failed', error, { error_class: 'mutation_failed' });
      await logger.flush();
      return c.json({ error: 'Archive key destroy failed' }, 503);
    }
  });

  app.post('/archive-api/key/rotation-failed', async (c) => {
    const logger = getRequestLogger(c.req.raw, { operation: 'archive_key_rotation_failed' });
    const authHeader = c.req.header('Authorization');
    const secret = process.env.ARCHIVE_API_SHARED_SECRET;
    if (!hasValidBearerSecret(authHeader, secret)) {
      logger.warn('convex.archive_key_shared_secret_invalid', {
        reason: unauthorizedReason(authHeader, secret),
      });
      await logger.flush();
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: { orgId?: string; operationId?: string };
    try {
      body = await c.req.json();
    } catch {
      logger.warn('convex.archive_key_request_invalid', { reason: 'invalid_json' });
      await logger.flush();
      return c.json({ error: 'Invalid request' }, 400);
    }
    if (
      !isConvexDocumentId(body.orgId) ||
      typeof body.operationId !== 'string' ||
      body.operationId.length === 0
    ) {
      logger.warn('convex.archive_key_request_invalid', { reason: 'invalid_rotation_failure' });
      await logger.flush();
      return c.json({ error: 'Invalid request' }, 400);
    }

    try {
      const recorded = await c.env.runMutation(internal.archiveKeysInternal.markRotationFailed, {
        orgId: body.orgId as Id<'organizations'>,
        operationId: body.operationId,
      });
      logger.info('convex.archive_key_rotation_failed_recorded', { recorded });
      await logger.flush();
      return c.json({ recorded });
    } catch (error) {
      logger.error('convex.archive_key_rotation_failed_write', error, {
        error_class: 'mutation_failed',
      });
      await logger.flush();
      return c.json({ error: 'Archive key rotation failure was not recorded' }, 503);
    }
  });
}
