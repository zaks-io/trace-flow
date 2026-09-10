import type { HonoWithConvex } from 'convex-helpers/server/hono';
import type { ActionCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { verifyPipesAccessGrant } from '../pipesAccessGrant';
import { hasValidBearerSecret, isConvexDocumentId, isJsonContentType } from './shared';

export function registerWorkerAuthorizationRoutes(app: HonoWithConvex<ActionCtx>): void {
  app.post('/worker/authorize-body-access', async (c) => {
    if (!hasValidBearerSecret(c.req.header('Authorization'), process.env.BODY_ACCESS_JWT_SECRET)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (!isJsonContentType(c.req.header('Content-Type'))) {
      return c.json({ error: 'Content-Type must be application/json' }, 415);
    }

    const body = await c.req
      .json<{ sub?: unknown; userId?: unknown; orgId?: unknown }>()
      .catch(() => null);
    if (
      !body ||
      typeof body.sub !== 'string' ||
      !isConvexDocumentId(body.userId) ||
      !isConvexDocumentId(body.orgId)
    ) {
      return c.json({ error: 'Invalid request' }, 400);
    }
    const authorized = await c.env.runQuery(internal.bodyAccess.authorizeSubject, {
      sub: body.sub,
      userId: body.userId as Id<'users'>,
      orgId: body.orgId as Id<'organizations'>,
    });
    return c.json({ authorized });
  });

  app.post('/worker/authorize-api-key', async (c) => {
    if (!hasValidBearerSecret(c.req.header('Authorization'), process.env.USAGE_SYNC_SECRET)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (!isJsonContentType(c.req.header('Content-Type'))) {
      return c.json({ error: 'Content-Type must be application/json' }, 415);
    }

    const body = await c.req.json<{ key?: unknown }>().catch(() => null);
    if (!body || typeof body.key !== 'string' || body.key.length === 0) {
      return c.json({ error: 'Invalid request' }, 400);
    }
    const apiKey = await c.env.runQuery(internal.integrations.cloudflare.getApiKeySyncData, {
      key: body.key,
    });
    if (!apiKey) {
      return c.json({ authorized: false as const, reason: 'invalid' });
    }
    if (apiKey.expiresAt <= Date.now()) {
      return c.json({ authorized: false as const, reason: 'expired' });
    }
    return c.json({
      authorized: true as const,
      orgId: apiKey.orgId,
      expiresAt: apiKey.expiresAt,
      createdAt: apiKey._creationTime,
    });
  });

  app.post('/worker/authorize-pipes-query', async (c) => {
    const secret = process.env.PIPES_API_SHARED_SECRET;
    if (!secret || !hasValidBearerSecret(c.req.header('Authorization'), secret)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (!isJsonContentType(c.req.header('Content-Type'))) {
      return c.json({ error: 'Content-Type must be application/json' }, 415);
    }

    const body = await c.req.json<{ grant?: unknown; pipe?: unknown }>().catch(() => null);
    if (!body || typeof body.grant !== 'string' || typeof body.pipe !== 'string') {
      return c.json({ error: 'Invalid request' }, 400);
    }
    const grant = await verifyPipesAccessGrant(body.grant, secret);
    if (
      !grant ||
      (grant.pipe !== undefined && grant.pipe !== body.pipe) ||
      !isConvexDocumentId(grant.userId) ||
      !isConvexDocumentId(grant.orgId)
    ) {
      return c.json({ authorized: false as const });
    }

    const authorization = await c.env.runAction(
      internal.integrations.tinybird.authorizePipesQuery,
      {
        userId: grant.userId as Id<'users'>,
        orgId: grant.orgId as Id<'organizations'>,
        pipe: body.pipe,
      },
    );
    if (!authorization) return c.json({ authorized: false as const });
    return c.json({
      authorized: true as const,
      token: authorization.token,
      expiresAt: Math.min(grant.expiresAt, authorization.expiresAt),
    });
  });
}
