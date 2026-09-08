import type { HonoWithConvex } from 'convex-helpers/server/hono';
import { traceContextFromHeaders, type TraceContext } from '@trace-flow/logging';
import { makeFunctionReference } from 'convex/server';
import type { ActionCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { getRequestLogger, hasValidBearerSecret, isConvexDocumentId } from './shared';

interface EnrollmentBody {
  hashedSecret?: string;
  authorizedSources?: { source?: string; historyChoice?: string }[];
  idempotencyKey?: string;
  orgId?: string;
  userId?: string;
  collectorId?: string;
  traceContext?: TraceContext;
}

const enrollCollectorByHashedSecret = makeFunctionReference<
  'mutation',
  {
    hashedSecret: string;
    authorizedSources: {
      source: 'claude' | 'codex';
      historyChoice: 'new_only' | 'all_history';
    }[];
    idempotencyKey: string;
    orgId: Id<'organizations'>;
    userId: Id<'users'>;
    collectorId: string;
    now: number;
  }
>('archiveInternal:enrollCollectorByHashedSecret');

export function registerArchiveEnrollRoutes(app: HonoWithConvex<ActionCtx>): void {
  app.post('/archive-api/enroll', async (c) => {
    const ctx = c.env;
    const requestTraceContext = traceContextFromHeaders(c.req.raw.headers);
    const authHeader = c.req.header('Authorization');
    const secret = process.env.ARCHIVE_API_SHARED_SECRET;
    if (!hasValidBearerSecret(authHeader, secret)) {
      const logger = getRequestLogger(c.req.raw, {
        operation: 'archive_enroll',
        ...requestTraceContext,
      });
      logger.warn('convex.archive_enroll_shared_secret_invalid');
      await logger.flush();
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: EnrollmentBody;
    try {
      body = await c.req.json<EnrollmentBody>();
    } catch {
      return c.json({ error: 'Invalid request' }, 400);
    }
    const logger = getRequestLogger(c.req.raw, {
      operation: 'archive_enroll',
      ...(body.traceContext ?? requestTraceContext),
      orgId: typeof body.orgId === 'string' ? body.orgId : undefined,
    });
    const invalid =
      typeof body.hashedSecret !== 'string' ||
      body.hashedSecret.length === 0 ||
      !isConvexDocumentId(body.orgId) ||
      !isConvexDocumentId(body.userId) ||
      typeof body.collectorId !== 'string' ||
      body.collectorId.length === 0 ||
      typeof body.idempotencyKey !== 'string' ||
      body.idempotencyKey.length === 0 ||
      !Array.isArray(body.authorizedSources) ||
      body.authorizedSources.length === 0 ||
      body.authorizedSources.some(
        (source) =>
          (source.source !== 'claude' && source.source !== 'codex') ||
          (source.historyChoice !== 'new_only' && source.historyChoice !== 'all_history'),
      );
    if (invalid) {
      logger.warn('convex.archive_enroll_request_invalid');
      await logger.flush();
      return c.json({ error: 'Invalid request' }, 400);
    }

    try {
      const result = await ctx.runMutation(enrollCollectorByHashedSecret, {
        hashedSecret: body.hashedSecret!,
        authorizedSources: body.authorizedSources as {
          source: 'claude' | 'codex';
          historyChoice: 'new_only' | 'all_history';
        }[],
        idempotencyKey: body.idempotencyKey!,
        orgId: body.orgId as Id<'organizations'>,
        userId: body.userId as Id<'users'>,
        collectorId: body.collectorId!,
        now: Date.now(),
      });
      await logger.flush();
      return c.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('consent_conflict')) {
        logger.warn('convex.archive_enroll_consent_conflict');
        await logger.flush();
        return c.json({ error: 'consent_conflict' }, 409);
      }
      logger.error('convex.archive_enroll_failed', error);
      await logger.flush();
      return c.json({ error: 'archive_unavailable' }, 503);
    }
  });
}
