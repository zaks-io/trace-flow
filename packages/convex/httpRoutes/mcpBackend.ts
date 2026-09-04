import type { HonoWithConvex } from 'convex-helpers/server/hono';
import type { ActionCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { createMcpBackend } from '../mcp/backend';
import { getRequestLogger, hasValidBearerSecret, isJsonContentType } from './shared';

export function registerMcpBackendRoutes(app: HonoWithConvex<ActionCtx>): void {
  // MCP backend: the dedicated MCP worker (mcp.trace-flow.dev) calls these
  // shared-secret routes so raw API keys and the Tinybird admin token never
  // leave Convex. The worker holds neither — it forwards a userId + key ids and
  // receives only public metadata + a scoped, short-lived Tinybird JWT.
  app.post('/mcp-backend/context', async (c) => {
    const ctx = c.env;
    const authHeader = c.req.header('Authorization');
    const secret = process.env.MCP_BACKEND_SHARED_SECRET;
    if (!hasValidBearerSecret(authHeader, secret)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (!isJsonContentType(c.req.header('Content-Type'))) {
      return c.json({ error: 'Content-Type must be application/json' }, 415);
    }

    const body = await c.req.json<{ userId: string }>();
    const backend = createMcpBackend(ctx, body.userId as Id<'users'>);
    const userContext = await backend.getUserContext();
    if (!userContext) {
      const logger = getRequestLogger(c.req.raw, { operation: 'mcp_backend_context' });
      logger.warn('convex.mcp_backend_user_not_found');
      await logger.flush();
      return c.json({ error: 'User not found' }, 404);
    }

    const apiKeys = await backend.listApiKeys();
    return c.json({
      enabled: userContext.enabled,
      retentionDays: userContext.retentionDays,
      apiKeys,
    });
  });

  app.post('/mcp-backend/mint', async (c) => {
    const ctx = c.env;
    const authHeader = c.req.header('Authorization');
    const secret = process.env.MCP_BACKEND_SHARED_SECRET;
    if (!hasValidBearerSecret(authHeader, secret)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (!isJsonContentType(c.req.header('Content-Type'))) {
      return c.json({ error: 'Content-Type must be application/json' }, 415);
    }

    const body = await c.req.json<{
      userId: string;
      scopes: { type: string; resource: string }[];
      apiKeyIds: string[];
      ttlSeconds?: number;
    }>();
    const logger = getRequestLogger(c.req.raw, { operation: 'mcp_backend_mint' });

    const userId = body.userId as Id<'users'>;
    const backend = createMcpBackend(ctx, userId);

    const userContext = await backend.getUserContext();
    if (!userContext) {
      logger.warn('convex.mcp_backend_user_not_found');
      await logger.flush();
      return c.json({ error: 'User not found' }, 404);
    }
    if (!userContext.enabled) {
      logger.warn('convex.mcp_backend_user_disabled');
      await logger.flush();
      return c.json({ error: 'User account is not enabled' }, 403);
    }

    // Re-validate ownership server-side — never trust the worker's id list. The
    // worker already surfaced a clean InvalidParams to the client, so a bad id
    // here is a contract violation, hence 400.
    const resolved = await backend.resolveKeyIds(body.apiKeyIds);
    if (!resolved.ok) {
      logger.warn('convex.mcp_backend_unowned_key_ids', { invalidIds: resolved.invalidIds });
      await logger.flush();
      return c.json({ error: 'Unknown or unauthorized API key IDs' }, 400);
    }

    // retentionDays is derived server-side from the user's tier — the worker
    // never supplies it.
    let token: string;
    try {
      token = await backend.mintToken(
        body.scopes,
        resolved.keyIds,
        userContext.retentionDays,
        body.ttlSeconds,
      );
    } catch (error) {
      logger.error('convex.mcp_backend_mint_failed', error);
      await logger.flush();
      return c.json({ error: 'Failed to mint token' }, 500);
    }
    await logger.flush();
    return c.json({ token });
  });
}
