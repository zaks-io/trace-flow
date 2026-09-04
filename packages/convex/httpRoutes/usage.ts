import type { HonoWithConvex } from 'convex-helpers/server/hono';
import { traceContextFromHeaders, type TraceContext } from '@trace-flow/logging';
import type { ActionCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { getRequestLogger, hasValidBearerSecret, isConvexDocumentId } from './shared';

export function registerUsageRoutes(app: HonoWithConvex<ActionCtx>): void {
  // Usage: DO pushes usage totals
  app.post('/usage/record', async (c) => {
    const ctx = c.env;
    const requestTraceContext = traceContextFromHeaders(c.req.raw.headers);

    const authHeader = c.req.header('Authorization');
    const secret = process.env.USAGE_SYNC_SECRET;
    if (!hasValidBearerSecret(authHeader, secret)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const body = await c.req.json<{
      orgId: string;
      periodStart: number;
      periodEnd: number;
      subscriptionUnitsUsed: number;
      addonUnitsUsed: number;
      traceContext?: TraceContext;
    }>();
    const logger = getRequestLogger(c.req.raw, {
      operation: 'usage_record',
      ...(body.traceContext ?? requestTraceContext),
      orgId: body.orgId,
    });

    if (!isConvexDocumentId(body.orgId)) {
      logger.warn('convex.usage_org_id_invalid');
      await logger.flush();
      return c.json({ error: 'Invalid organization id' }, 400);
    }

    const orgId = body.orgId as Id<'organizations'>;

    // Verify the org exists before recording usage
    const org = await ctx.runQuery(internal.auth.organizations.getByIdInternal, { id: orgId });
    if (!org) {
      logger.warn('convex.usage_org_not_found');
      await logger.flush();
      return c.json({ error: 'Organization not found' }, 404);
    }

    await ctx.runMutation(internal.billing.usage.recordUsage, {
      orgId,
      periodStart: body.periodStart,
      periodEnd: body.periodEnd,
      subscriptionUnitsUsed: body.subscriptionUnitsUsed,
      addonUnitsUsed: body.addonUnitsUsed,
    });

    await ctx.runMutation(internal.billing.usage.checkAutoTopup, {
      orgId,
      subscriptionUnitsUsed: body.subscriptionUnitsUsed,
      addonUnitsUsed: body.addonUnitsUsed,
    });

    logger.info('convex.usage_recorded', {
      periodStart: body.periodStart,
      periodEnd: body.periodEnd,
      subscriptionUnitsUsed: body.subscriptionUnitsUsed,
      addonUnitsUsed: body.addonUnitsUsed,
    });

    await logger.flush();
    return c.json({ ok: true });
  });
}
