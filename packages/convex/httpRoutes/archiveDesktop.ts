import type { HonoWithConvex } from 'convex-helpers/server/hono';
import type { ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import type { HttpDeps } from './deps';
import { redirectLoopbackAuthorize } from './loopbackAuthorize';
import { getRequestLogger, isConvexDocumentId, isJsonContentType } from './shared';

const ARCHIVE_STATE_PREFIX = 'archive:';

function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

async function requireArchiveSession(
  oauth: HttpDeps['oauth'],
  authHeader: string | undefined,
): Promise<{ userId: Id<'users'>; orgId: Id<'organizations'> } | Response> {
  const token = bearerToken(authHeader);
  if (!token) {
    return new Response(JSON.stringify({ error: 'Archive session required' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const session = await oauth.verifyArchiveSession(token);
  if (!session || !isConvexDocumentId(session.userId) || !isConvexDocumentId(session.orgId)) {
    return new Response(JSON.stringify({ error: 'Archive session invalid' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return {
    userId: session.userId as Id<'users'>,
    orgId: session.orgId as Id<'organizations'>,
  };
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function runEnrollmentLeave(
  c: {
    req: {
      raw: Request;
      header: (name: string) => string | undefined;
      json: () => Promise<unknown>;
    };
    json: (data: unknown, status?: number) => Response;
  },
  oauth: HttpDeps['oauth'],
  options: {
    operation: string;
    failEvent: string;
    failMessage: string;
    mutate: (userId: Id<'users'>, enrollmentId: Id<'archiveEnrollments'>) => Promise<unknown>;
  },
): Promise<Response> {
  const logger = getRequestLogger(c.req.raw, { operation: options.operation });
  const session = await requireArchiveSession(oauth, c.req.header('Authorization'));
  if (session instanceof Response) return session;
  const body = (await c.req.json().catch(() => null)) as { enrollmentId?: unknown } | null;
  if (!body || typeof body.enrollmentId !== 'string' || !isConvexDocumentId(body.enrollmentId)) {
    return jsonError('enrollmentId is required', 400);
  }
  try {
    await options.mutate(session.userId, body.enrollmentId as Id<'archiveEnrollments'>);
    await logger.flush();
    return c.json({ ok: true });
  } catch (error) {
    logger.warn(options.failEvent, {
      error: error instanceof Error ? error.message : String(error),
    });
    await logger.flush();
    return jsonError(error instanceof Error ? error.message : options.failMessage, 400);
  }
}

export function registerArchiveDesktopRoutes(
  app: HonoWithConvex<ActionCtx>,
  { oauth }: HttpDeps,
): void {
  app.get('/archive/authorize', async (c) =>
    redirectLoopbackAuthorize(c, oauth, {
      operation: 'archive_authorize',
      badRedirectEvent: 'convex.archive_authorize_bad_redirect',
      clientStatePrefix: ARCHIVE_STATE_PREFIX,
    }),
  );

  app.post('/archive/desktop/snapshot', async (c) => {
    const logger = getRequestLogger(c.req.raw, { operation: 'archive_desktop_snapshot' });
    const session = await requireArchiveSession(oauth, c.req.header('Authorization'));
    if (session instanceof Response) return session;
    if (!isJsonContentType(c.req.header('Content-Type'))) {
      return jsonError('JSON body required', 400);
    }
    const body = (await c.req.json().catch(() => null)) as { collectorId?: unknown } | null;
    if (!body || typeof body.collectorId !== 'string' || body.collectorId.length === 0) {
      return jsonError('collectorId is required', 400);
    }
    try {
      const snapshot = await c.env.runQuery(internal.archiveDesktop.snapshotForUser, {
        userId: session.userId,
        collectorId: body.collectorId,
      });
      if (snapshot.orgId !== session.orgId) {
        return jsonError('Archive session org mismatch', 403);
      }
      await logger.flush();
      return c.json(snapshot);
    } catch (error) {
      logger.warn('convex.archive_desktop_snapshot_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      await logger.flush();
      return jsonError(error instanceof Error ? error.message : 'Snapshot failed', 400);
    }
  });

  app.post('/archive/desktop/activate', async (c) => {
    const logger = getRequestLogger(c.req.raw, { operation: 'archive_desktop_activate' });
    const session = await requireArchiveSession(oauth, c.req.header('Authorization'));
    if (session instanceof Response) return session;
    try {
      const result = await c.env.runMutation(internal.archiveDesktop.activateForUser, {
        userId: session.userId,
      });
      logger.info('convex.archive_desktop_activated', { created: result.created });
      await logger.flush();
      return c.json(result);
    } catch (error) {
      logger.warn('convex.archive_desktop_activate_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      await logger.flush();
      return jsonError(error instanceof Error ? error.message : 'Activation failed', 400);
    }
  });

  app.post('/archive/desktop/enroll', async (c) => {
    const logger = getRequestLogger(c.req.raw, { operation: 'archive_desktop_enroll' });
    const session = await requireArchiveSession(oauth, c.req.header('Authorization'));
    if (session instanceof Response) return session;
    if (!isJsonContentType(c.req.header('Content-Type'))) {
      return jsonError('JSON body required', 400);
    }
    const body = (await c.req.json().catch(() => null)) as {
      collectorId?: unknown;
      authorizedSources?: unknown;
      idempotencyKey?: unknown;
    } | null;
    if (
      !body ||
      typeof body.collectorId !== 'string' ||
      typeof body.idempotencyKey !== 'string' ||
      !Array.isArray(body.authorizedSources)
    ) {
      return jsonError('collectorId, authorizedSources, and idempotencyKey are required', 400);
    }
    try {
      const result = await c.env.runMutation(internal.archiveDesktop.enrollForUser, {
        userId: session.userId,
        collectorId: body.collectorId,
        authorizedSources: body.authorizedSources as {
          source: 'claude' | 'codex';
          historyChoice: 'new_only' | 'all_history';
        }[],
        idempotencyKey: body.idempotencyKey,
      });
      logger.info('convex.archive_desktop_enrolled', { created: result.created });
      await logger.flush();
      return c.json(result);
    } catch (error) {
      logger.warn('convex.archive_desktop_enroll_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      await logger.flush();
      return jsonError(error instanceof Error ? error.message : 'Enrollment failed', 400);
    }
  });

  app.post('/archive/desktop/unenroll', async (c) =>
    runEnrollmentLeave(c, oauth, {
      operation: 'archive_desktop_unenroll',
      failEvent: 'convex.archive_desktop_unenroll_failed',
      failMessage: 'Unenroll failed',
      mutate: (userId, enrollmentId) =>
        c.env.runMutation(internal.archiveDesktop.unenrollForUser, { userId, enrollmentId }),
    }),
  );

  app.post('/archive/desktop/revoke', async (c) =>
    runEnrollmentLeave(c, oauth, {
      operation: 'archive_desktop_revoke',
      failEvent: 'convex.archive_desktop_revoke_failed',
      failMessage: 'Revoke failed',
      mutate: (userId, enrollmentId) =>
        c.env.runMutation(internal.archiveDesktop.revokeForUser, { userId, enrollmentId }),
    }),
  );
}

export const ARCHIVE_DESKTOP_STATE_PREFIX = ARCHIVE_STATE_PREFIX;
