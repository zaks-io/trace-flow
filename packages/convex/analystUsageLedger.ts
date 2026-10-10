import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';

export type LedgerAgent = 'analyst';

/** A single usage increment to fold into a ledger row. */
export interface UsageDelta {
  totalTokens: number;
  totalCost: number;
  cacheReadTokens: number;
  /** How many LLM calls/snapshots this delta represents (1 per step). */
  requests: number;
  /** Whether this delta carried a real (provider-reported) cost. */
  hasCost: boolean;
}

/** Empty totals — the identity a fresh thread/agent starts from. */
export function emptyTotals() {
  return { totalTokens: 0, totalCost: 0, cacheReadTokens: 0, requests: 0, hasCost: false };
}

/** Pure fold: existing totals + delta → new totals. Negative deltas are clamped to keep totals monotonic. */
export function applyDelta(
  current: ReturnType<typeof emptyTotals>,
  delta: UsageDelta,
): ReturnType<typeof emptyTotals> {
  return {
    totalTokens: current.totalTokens + Math.max(0, delta.totalTokens),
    totalCost: current.totalCost + Math.max(0, delta.totalCost),
    cacheReadTokens: current.cacheReadTokens + Math.max(0, delta.cacheReadTokens),
    requests: current.requests + Math.max(0, delta.requests),
    hasCost: current.hasCost || delta.hasCost,
  };
}

/** True when the delta carries nothing worth a write. */
export function isEmptyDelta(delta: UsageDelta): boolean {
  return (
    delta.totalTokens <= 0 &&
    delta.totalCost <= 0 &&
    delta.cacheReadTokens <= 0 &&
    delta.requests <= 0 &&
    !delta.hasCost
  );
}

/** Upsert one (thread, agent) ledger row by adding `delta` to its running totals. */
export async function accumulateLedger(
  ctx: MutationCtx,
  args: {
    analystThreadId: Id<'analystThreads'>;
    orgId: Id<'organizations'>;
    creatorUserId: Id<'users'>;
    agent: LedgerAgent;
    delta: UsageDelta;
    now: number;
  },
): Promise<void> {
  if (isEmptyDelta(args.delta)) return;

  const existing = await ctx.db
    .query('analystUsageLedger')
    .withIndex('by_thread_agent', (q) =>
      q.eq('analystThreadId', args.analystThreadId).eq('agent', args.agent),
    )
    .first();

  const next = applyDelta(existing ?? emptyTotals(), args.delta);

  if (existing) {
    await ctx.db.patch(existing._id, { ...next, updatedAt: args.now });
    return;
  }

  await ctx.db.insert('analystUsageLedger', {
    analystThreadId: args.analystThreadId,
    orgId: args.orgId,
    creatorUserId: args.creatorUserId,
    agent: args.agent,
    ...next,
    updatedAt: args.now,
  });
}

/** Read the Analyst LLM totals; legacy runtime rows are no longer read. */
export async function readThreadLedger(
  ctx: QueryCtx | MutationCtx,
  analystThreadId: Id<'analystThreads'>,
) {
  const row = await ctx.db
    .query('analystUsageLedger')
    .withIndex('by_thread_agent', (q) =>
      q.eq('analystThreadId', analystThreadId).eq('agent', 'analyst'),
    )
    .first();

  return {
    analyst: {
      totalTokens: row?.totalTokens ?? 0,
      totalCost: row?.totalCost ?? 0,
      hasCost: row?.hasCost ?? false,
    },
  };
}
