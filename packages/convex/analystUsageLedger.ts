import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';

export type LedgerAgent = 'analyst' | 'pi';

/** A single usage increment to fold into a ledger row. */
export interface UsageDelta {
  totalTokens: number;
  totalCost: number;
  cacheReadTokens: number;
  /** How many LLM calls/snapshots this delta represents (analyst: 1 per step; Pi: 1 per applied snapshot). */
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

/** A run's cumulative usage snapshot (Pi reports running totals, not per-step). */
export interface CumulativeUsage {
  totalTokens: number;
  totalCost: number;
  cacheReadTokens: number;
}

export const ZERO_CUMULATIVE: CumulativeUsage = {
  totalTokens: 0,
  totalCost: 0,
  cacheReadTokens: 0,
};

/**
 * The delta to add to the Pi ledger given a new cumulative snapshot and the last one
 * already applied. Counts one priced request only when the snapshot actually advanced
 * and carried cost. The caller persists `next` as the new last-applied baseline.
 */
export function cumulativeDelta(
  applied: CumulativeUsage,
  next: CumulativeUsage,
  nextHasCost: boolean,
): UsageDelta {
  return {
    totalTokens: next.totalTokens - applied.totalTokens,
    totalCost: next.totalCost - applied.totalCost,
    cacheReadTokens: next.cacheReadTokens - applied.cacheReadTokens,
    requests: next.totalTokens > applied.totalTokens ? 1 : 0,
    hasCost: nextHasCost,
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

/** Read both agent rows for a thread, returning the summary shape the UI expects. */
export async function readThreadLedger(
  ctx: QueryCtx | MutationCtx,
  analystThreadId: Id<'analystThreads'>,
): Promise<Record<LedgerAgent, { totalTokens: number; totalCost: number; hasCost: boolean }>> {
  const rows = await ctx.db
    .query('analystUsageLedger')
    .withIndex('by_thread', (q) => q.eq('analystThreadId', analystThreadId))
    .collect();

  return {
    analyst: pickTotals(rows, 'analyst'),
    pi: pickTotals(rows, 'pi'),
  };
}

function pickTotals(rows: Doc<'analystUsageLedger'>[], agent: LedgerAgent) {
  const row = rows.find((r) => r.agent === agent);
  return {
    totalTokens: row?.totalTokens ?? 0,
    totalCost: row?.totalCost ?? 0,
    hasCost: row?.hasCost ?? false,
  };
}
