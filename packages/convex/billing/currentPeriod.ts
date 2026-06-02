import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';

interface BillingReadCtx {
  db: QueryCtx['db'];
}

export interface CurrentBillingPeriod {
  subscription: Doc<'subscriptions'>;
  usage: Doc<'usage'> | null;
}

export function summarizeCurrentUsage(
  subscription: Doc<'subscriptions'>,
  usage: Doc<'usage'> | null,
): { totalUsed: number; totalAvailable: number; remaining: number } {
  const totalUsed = (usage?.subscriptionUnitsUsed ?? 0) + (usage?.addonUnitsUsed ?? 0);
  const totalAvailable = subscription.monthlyUnits + subscription.addonUnits;

  return {
    totalUsed,
    totalAvailable,
    remaining: Math.max(0, totalAvailable - totalUsed),
  };
}

export async function getSubscriptionByOrgId(
  ctx: BillingReadCtx,
  orgId: Id<'organizations'>,
): Promise<Doc<'subscriptions'> | null> {
  return ctx.db
    .query('subscriptions')
    .withIndex('by_org_id', (q) => q.eq('orgId', orgId))
    .first();
}

export async function getUsageForPeriod(
  ctx: BillingReadCtx,
  orgId: Id<'organizations'>,
  periodStart: number,
): Promise<Doc<'usage'> | null> {
  return ctx.db
    .query('usage')
    .withIndex('by_org_id_period', (q) => q.eq('orgId', orgId).eq('periodStart', periodStart))
    .first();
}

export async function getCurrentBillingPeriod(
  ctx: BillingReadCtx,
  orgId: Id<'organizations'>,
): Promise<CurrentBillingPeriod | null> {
  const subscription = await getSubscriptionByOrgId(ctx, orgId);
  if (!subscription) return null;

  const usage = await getUsageForPeriod(ctx, orgId, subscription.currentPeriodStart);
  return { subscription, usage };
}

export function mutationReadCtx(ctx: MutationCtx): BillingReadCtx {
  return { db: ctx.db };
}
