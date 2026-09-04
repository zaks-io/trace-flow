import type { HonoWithConvex } from 'convex-helpers/server/hono';
import { traceContextFromHeaders, type TraceContext } from '@trace-flow/logging';
import type { ActionCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { getRequestLogger, hasValidBearerSecret, isConvexDocumentId } from './shared';

export function registerAgentIngestRoutes(app: HonoWithConvex<ActionCtx>): void {
  // Agent ingest: Worker claims first-writer ownership of Agent Sessions before
  // enqueueing facts. Shared-secret guarded like /usage/record (the Worker, not
  // a browser, calls this). Partial-conflict batches skip only the conflicting
  // sessions and continue, so one historical conflict never blocks current work.
  app.post('/agent-ingest/claim-sessions', async (c) => {
    const ctx = c.env;
    const requestTraceContext = traceContextFromHeaders(c.req.raw.headers);

    const authHeader = c.req.header('Authorization');
    const secret = process.env.AGENT_INGEST_SHARED_SECRET;
    if (!hasValidBearerSecret(authHeader, secret)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const body = await c.req.json<{
      orgId: string;
      userId: string;
      collectorId: string;
      sessionPks: string[];
      traceContext?: TraceContext;
    }>();
    const logger = getRequestLogger(c.req.raw, {
      operation: 'agent_claim_sessions',
      ...(body.traceContext ?? requestTraceContext),
      orgId: body.orgId,
    });

    // Cap the batch so a single request can't fan out into unbounded claim
    // mutations. The ingest Worker chunks well under this.
    const MAX_SESSION_PKS = 1000;
    if (!Array.isArray(body.sessionPks) || body.sessionPks.length > MAX_SESSION_PKS) {
      logger.warn('convex.agent_claim_batch_too_large', { count: body.sessionPks?.length });
      await logger.flush();
      return c.json({ error: `sessionPks must be an array of at most ${MAX_SESSION_PKS}` }, 400);
    }

    if (!isConvexDocumentId(body.orgId)) {
      logger.warn('convex.agent_claim_org_id_invalid');
      await logger.flush();
      return c.json({ error: 'Invalid organization id' }, 400);
    }

    const orgId = body.orgId as Id<'organizations'>;
    const org = await ctx.runQuery(internal.auth.organizations.getByIdInternal, { id: orgId });
    if (!org) {
      logger.warn('convex.agent_claim_org_not_found');
      await logger.flush();
      return c.json({ error: 'Organization not found' }, 404);
    }

    if (!isConvexDocumentId(body.userId)) {
      logger.warn('convex.agent_claim_user_id_invalid');
      await logger.flush();
      return c.json({ error: 'Invalid user id' }, 400);
    }

    const userId = body.userId as Id<'users'>;
    const user = await ctx.runQuery(internal.auth.users.getUserById, { id: userId });
    if (user?.orgId !== orgId) {
      logger.warn('convex.agent_claim_user_invalid', { userIdValid: Boolean(user) });
      await logger.flush();
      return c.json({ error: 'User not found in organization' }, 404);
    }

    // One batched mutation for the whole envelope's sessions: a single OCC transaction instead of one
    // round-trip per session. OCC still enforces first-writer per (orgId, session_pk) across
    // concurrent batches. The batch is bounded by MAX_SESSION_PKS above.
    const results = await ctx.runMutation(internal.agentSessionOwners.claimSessionsBatch, {
      orgId,
      sessionPks: body.sessionPks,
      userId,
      collectorId: body.collectorId,
    });

    const conflicts = results.filter((r) => r.status === 'conflict').length;
    logger.info('convex.agent_sessions_claimed', {
      requested: body.sessionPks.length,
      conflicts,
    });

    await logger.flush();
    return c.json({ results });
  });

  // Agent ingest: Worker fetches the compatibility policy (it edge-caches the
  // result). Empty policy → 404 so the Worker fails closed with
  // `policy_unavailable` rather than accepting unknown client versions.
  app.get('/agent-ingest/compatibility-policy', async (c) => {
    const ctx = c.env;

    const authHeader = c.req.header('Authorization');
    const secret = process.env.AGENT_INGEST_SHARED_SECRET;
    if (!hasValidBearerSecret(authHeader, secret)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const policy = await ctx.runQuery(
      internal.collectorCompatibilityPolicy.getActivePolicyInternal,
      {},
    );
    if (!policy) {
      const logger = getRequestLogger(c.req.raw, { operation: 'agent_compatibility_policy' });
      logger.warn('convex.agent_policy_unavailable');
      await logger.flush();
      return c.json({ error: 'policy_unavailable' }, 404);
    }

    return c.json(policy);
  });
}
