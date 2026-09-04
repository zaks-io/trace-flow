import type { HonoWithConvex } from 'convex-helpers/server/hono';
import { traceContextFromHeaders, type TraceContext } from '@trace-flow/logging';
import type { ActionCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { getRequestLogger, hasValidBearerSecret, isConvexDocumentId } from './shared';

export function registerArchiveAuthorizeRoutes(app: HonoWithConvex<ActionCtx>): void {
  // Archive API: Worker authorizes an enrolled upload against current Convex
  // enrollment + Source policy. Shared-secret guarded like /agent-ingest/*.
  // Live reads win races with unenrollment / revocation / member removal.
  app.post('/archive-api/authorize-write', async (c) => {
    const ctx = c.env;
    const requestTraceContext = traceContextFromHeaders(c.req.raw.headers);

    const authHeader = c.req.header('Authorization');
    const secret = process.env.ARCHIVE_API_SHARED_SECRET;
    if (!hasValidBearerSecret(authHeader, secret)) {
      const logger = getRequestLogger(c.req.raw, {
        operation: 'archive_authorize_write',
        ...requestTraceContext,
      });
      logger.warn('convex.archive_authorize_shared_secret_invalid', {
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

    const body = await c.req.json<{
      hashedSecret?: string;
      source?: string;
      orgId?: string;
      userId?: string;
      collectorId?: string;
      traceContext?: TraceContext;
    }>();
    const logger = getRequestLogger(c.req.raw, {
      operation: 'archive_authorize_write',
      ...(body.traceContext ?? requestTraceContext),
      orgId: typeof body.orgId === 'string' ? body.orgId : undefined,
    });

    if (typeof body.hashedSecret !== 'string' || body.hashedSecret.length === 0) {
      logger.warn('convex.archive_authorize_hashed_secret_invalid');
      await logger.flush();
      return c.json({ error: 'Invalid hashed secret' }, 400);
    }
    if (body.source !== 'claude' && body.source !== 'codex') {
      logger.warn('convex.archive_authorize_source_invalid');
      await logger.flush();
      return c.json({ error: 'Invalid source' }, 400);
    }
    if (!isConvexDocumentId(body.orgId)) {
      logger.warn('convex.archive_authorize_org_id_invalid');
      await logger.flush();
      return c.json({ error: 'Invalid organization id' }, 400);
    }
    if (!isConvexDocumentId(body.userId)) {
      logger.warn('convex.archive_authorize_user_id_invalid');
      await logger.flush();
      return c.json({ error: 'Invalid user id' }, 400);
    }
    if (typeof body.collectorId !== 'string' || body.collectorId.length === 0) {
      logger.warn('convex.archive_authorize_collector_id_invalid');
      await logger.flush();
      return c.json({ error: 'Invalid collector id' }, 400);
    }

    const decision = await ctx.runQuery(
      internal.archiveInternal.authorizeArchiveWriteByHashedSecret,
      {
        hashedSecret: body.hashedSecret,
        source: body.source,
        orgId: body.orgId as Id<'organizations'>,
        userId: body.userId as Id<'users'>,
        collectorId: body.collectorId,
        now: Date.now(),
      },
    );

    logger.info('convex.archive_write_authorized', {
      allowed: decision.allowed,
      reason: decision.allowed ? undefined : decision.reason,
    });
    await logger.flush();
    return c.json(decision);
  });
}
