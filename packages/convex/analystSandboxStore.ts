import { v } from 'convex/values';
import { runUsageTotal, type SandboxRunEventInput } from './analystPiRows';
import {
  accumulateLedger,
  cumulativeDelta,
  maxCumulative,
  ZERO_CUMULATIVE,
  type CumulativeUsage,
} from './analystUsageLedger';
import { sandboxRunEventInput } from './analystSandboxSchema';
import {
  ACTIVE_SANDBOX_RUN_STATUSES,
  isActiveSandboxRunStatus,
  sandboxRunDeadlineMs,
  shouldScheduleContinuation,
} from './analystSandboxPolicy';
import { internalMutation, internalQuery, type MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';

const MAX_SANDBOX_EVENT_BATCH = 50;
const MAX_SANDBOX_EVENT_MESSAGE_CHARS = 20_000;
const MAX_SANDBOX_RESULT_CHARS = 120_000;

const pageContextReferenceValidator = v.object({
  surface: v.literal('agents'),
  objectId: v.string(),
  label: v.string(),
  route: v.string(),
  filters: v.optional(v.record(v.string(), v.union(v.string(), v.number(), v.boolean(), v.null()))),
});

const sandboxControlActionValidator = v.union(
  v.literal('status'),
  v.literal('tail'),
  v.literal('cancel'),
  v.literal('steer'),
  v.literal('follow_up'),
);

function truncateText(value: string | undefined, maxChars: number): string | undefined {
  if (!value) return value;
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated]`;
}

export const getSandboxRunForAction = internalQuery({
  args: { runId: v.id('analystSandboxRuns') },
  handler: async (ctx, args) => ctx.db.get(args.runId),
});

export const getOwnedSandboxRunForAction = internalQuery({
  args: {
    runId: v.id('analystSandboxRuns'),
    userId: v.id('users'),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (run?.creatorUserId !== args.userId) return null;
    return run;
  },
});

export const getActiveSandboxRunsForAction = internalQuery({
  args: {
    threadId: v.id('analystThreads'),
    userId: v.id('users'),
  },
  handler: async (ctx, args) => {
    const thread = await ctx.db.get(args.threadId);
    if (thread?.creatorUserId !== args.userId || thread?.status !== 'active') return [];
    const runs = await ctx.db
      .query('analystSandboxRuns')
      .withIndex('by_thread_updated', (q) => q.eq('analystThreadId', args.threadId))
      .collect();
    return runs.filter(
      (run) => run.creatorUserId === args.userId && isActiveSandboxRunStatus(run.status),
    );
  },
});

/** Run plus its thread's resume context, for the liveness watchdog. */
export const getSandboxRunLivenessContext = internalQuery({
  args: { runId: v.id('analystSandboxRuns') },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) return null;
    const thread = await ctx.db.get(run.analystThreadId);
    return {
      run,
      backup: thread?.sandboxBackup ?? null,
    };
  },
});

export const getVerifiedSandboxRunForAction = internalQuery({
  args: {
    runId: v.id('analystSandboxRuns'),
    tokenHash: v.string(),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (run?.runTokenHash !== args.tokenHash) return null;
    return run;
  },
});

export const getSandboxRunEventsForAction = internalQuery({
  args: {
    runId: v.id('analystSandboxRuns'),
    userId: v.id('users'),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (run?.creatorUserId !== args.userId) return [];
    const limit = Math.min(Math.max(args.limit, 1), 100);
    const events = await ctx.db
      .query('analystSandboxRunEvents')
      .withIndex('by_run_seq', (q) => q.eq('runId', args.runId))
      .collect();
    return events
      .sort((a, b) => b.seq - a.seq)
      .slice(0, limit)
      .reverse();
  },
});

export const getSandboxRunForReap = internalQuery({
  args: { runId: v.id('analystSandboxRuns') },
  handler: async (ctx, args) => ctx.db.get(args.runId),
});

export const createSandboxRun = internalMutation({
  args: {
    analystThreadId: v.id('analystThreads'),
    creatorUserId: v.id('users'),
    orgId: v.id('organizations'),
    sandboxId: v.string(),
    prompt: v.string(),
    pageContextReferences: v.optional(v.array(pageContextReferenceValidator)),
    runTokenHash: v.string(),
    maxRuntimeMs: v.number(),
    resumeAttempt: v.optional(v.number()),
    now: v.number(),
  },
  handler: async (ctx, args): Promise<Id<'analystSandboxRuns'>> => {
    return ctx.db.insert('analystSandboxRuns', {
      analystThreadId: args.analystThreadId,
      creatorUserId: args.creatorUserId,
      orgId: args.orgId,
      sandboxId: args.sandboxId,
      prompt: args.prompt,
      pageContextReferences: args.pageContextReferences,
      status: 'starting',
      runTokenHash: args.runTokenHash,
      maxRuntimeMs: args.maxRuntimeMs,
      resumeAttempt: args.resumeAttempt,
      updatedAt: args.now,
      nextSeq: 0,
    });
  },
});

export const markSandboxRunStarted = internalMutation({
  args: {
    runId: v.id('analystSandboxRuns'),
    userId: v.id('users'),
    processId: v.optional(v.string()),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (run?.creatorUserId !== args.userId) throw new Error('Pi run not found');
    if (!['starting', 'queued'].includes(run.status)) return;
    await ctx.db.patch(args.runId, {
      status: 'running',
      processId: args.processId,
      startedAt: args.now,
      updatedAt: args.now,
      lastEventAt: args.now,
    });
  },
});

export const appendSandboxRunEvents = internalMutation({
  args: {
    runId: v.id('analystSandboxRuns'),
    tokenHash: v.string(),
    events: v.array(sandboxRunEventInput),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (run?.runTokenHash !== args.tokenHash) throw new Error('Pi run not found');

    let seq = run.nextSeq;
    const batch = args.events.slice(0, MAX_SANDBOX_EVENT_BATCH);
    const usageInputs: SandboxRunEventInput[] = [];
    for (const event of batch) {
      const id = await ctx.db.insert('analystSandboxRunEvents', {
        runId: args.runId,
        analystThreadId: run.analystThreadId,
        creatorUserId: run.creatorUserId,
        orgId: run.orgId,
        seq,
        type: event.type,
        message: truncateText(event.message, MAX_SANDBOX_EVENT_MESSAGE_CHARS),
        data: event.data,
        emittedAt: event.emittedAt ?? args.now,
      });
      if (event.type === 'usage') {
        usageInputs.push({
          _id: id,
          seq,
          type: event.type,
          message: event.message,
          data: event.data,
          emittedAt: event.emittedAt ?? args.now,
        });
      }
      seq += 1;
    }

    // Pi emits cumulative usage snapshots; fold only the delta of the latest snapshot
    // in this batch into the (thread, 'pi') ledger so resumes/restreams don't double-count.
    const usageApplied = await accumulatePiUsage(ctx, run, usageInputs, args.now);

    await ctx.db.patch(args.runId, {
      nextSeq: seq,
      lastEventAt: args.now,
      updatedAt: args.now,
      status: run.status === 'starting' ? 'running' : run.status,
      ...(usageApplied ? { usageApplied } : {}),
    });
  },
});

/**
 * Fold the delta of this batch's latest cumulative usage snapshot into the Pi ledger.
 * Returns the new last-applied total to persist on the run, or null if nothing changed.
 */
async function accumulatePiUsage(
  ctx: MutationCtx,
  run: Doc<'analystSandboxRuns'>,
  usageInputs: SandboxRunEventInput[],
  now: number,
): Promise<CumulativeUsage | null> {
  const latest = runUsageTotal(usageInputs);
  if (!latest) return null;

  const applied = run.usageApplied ?? ZERO_CUMULATIVE;
  const cumulative: CumulativeUsage = {
    totalTokens: latest.totalTokens ?? 0,
    totalCost: latest.totalCost ?? 0,
    cacheReadTokens: latest.cacheRead ?? 0,
  };
  const delta = cumulativeDelta(applied, cumulative, latest.totalCost !== undefined);

  await accumulateLedger(ctx, {
    analystThreadId: run.analystThreadId,
    orgId: run.orgId,
    creatorUserId: run.creatorUserId,
    agent: 'pi',
    delta,
    now,
  });

  // Persist a monotonic baseline. A resume can report a cumulative below the prior one;
  // accumulateLedger already clamps the negative delta, but storing the regressed value as the
  // baseline would re-add the recovered tokens on the next advance and double-count.
  return maxCumulative(applied, cumulative);
}

export const completeSandboxRunInternal = internalMutation({
  args: {
    runId: v.id('analystSandboxRuns'),
    tokenHash: v.string(),
    status: v.union(
      v.literal('completed'),
      v.literal('failed'),
      v.literal('timed_out'),
      v.literal('cancelled'),
    ),
    resultText: v.optional(v.string()),
    error: v.optional(v.string()),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (run?.runTokenHash !== args.tokenHash) throw new Error('Pi run not found');
    if (['completed', 'failed', 'timed_out', 'cancelled'].includes(run.status)) return run;

    const resultText = truncateText(args.resultText, MAX_SANDBOX_RESULT_CHARS);
    const error = truncateText(args.error, MAX_SANDBOX_EVENT_MESSAGE_CHARS);
    const seq = run.nextSeq;
    await ctx.db.insert('analystSandboxRunEvents', {
      runId: args.runId,
      analystThreadId: run.analystThreadId,
      creatorUserId: run.creatorUserId,
      orgId: run.orgId,
      seq,
      type: args.status === 'completed' ? 'result' : 'error',
      message: args.status === 'completed' ? resultText : error,
      data: { status: args.status },
      emittedAt: args.now,
    });

    const patch = {
      status: args.status,
      resultText,
      error,
      completedAt: args.now,
      lastEventAt: args.now,
      updatedAt: args.now,
      nextSeq: seq + 1,
    } as const;
    await ctx.db.patch(args.runId, patch);
    return { ...run, ...patch };
  },
});

/**
 * Close out a run whose container went silent (deploy rollout, eviction, crash).
 * Records an explicit interrupted event then marks the run terminal. Keyed by
 * runId only — this is server-internal, not the runner posting with its token.
 */
export const markSandboxRunInterrupted = internalMutation({
  args: {
    runId: v.id('analystSandboxRuns'),
    error: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) return null;
    if (!ACTIVE_SANDBOX_RUN_STATUSES.has(run.status)) return run;

    const seq = run.nextSeq;
    await ctx.db.insert('analystSandboxRunEvents', {
      runId: args.runId,
      analystThreadId: run.analystThreadId,
      creatorUserId: run.creatorUserId,
      orgId: run.orgId,
      seq,
      type: 'error',
      message: args.error,
      data: { status: 'timed_out', lastEventAt: run.lastEventAt },
      emittedAt: args.now,
    });

    const patch = {
      status: 'timed_out',
      error: args.error,
      completedAt: args.now,
      lastEventAt: args.now,
      updatedAt: args.now,
      nextSeq: seq + 1,
    } as const;
    await ctx.db.patch(args.runId, patch);
    return { ...run, ...patch };
  },
});

/** Append an informational note (e.g. "Resumed after interruption") to a run's work log. */
export const emitSandboxRunNote = internalMutation({
  args: {
    runId: v.id('analystSandboxRuns'),
    label: v.string(),
    text: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) return;
    const seq = run.nextSeq;
    await ctx.db.insert('analystSandboxRunEvents', {
      runId: args.runId,
      analystThreadId: run.analystThreadId,
      creatorUserId: run.creatorUserId,
      orgId: run.orgId,
      seq,
      type: 'status',
      message: args.label,
      data: { kind: 'note', label: args.label, text: args.text, tone: 'normal' },
      emittedAt: args.now,
    });
    await ctx.db.patch(args.runId, { nextSeq: seq + 1, updatedAt: args.now });
  },
});

export const storeThreadSandboxBackup = internalMutation({
  args: {
    runId: v.id('analystSandboxRuns'),
    tokenHash: v.string(),
    backup: v.object({
      id: v.string(),
      dir: v.string(),
      localBucket: v.optional(v.boolean()),
    }),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (run?.runTokenHash !== args.tokenHash) throw new Error('Pi run not found');

    // A late callback from an older run can arrive after a newer run already stored a fresher
    // snapshot. The backup is a single per-thread slot, so reject a write whose snapshot is not
    // newer than the stored one — never let a stale checkpoint clobber the resume state.
    const thread = await ctx.db.get(run.analystThreadId);
    const existing = thread?.sandboxBackup;
    if (existing && existing.updatedAt >= args.now) return;

    await ctx.db.patch(run.analystThreadId, {
      sandboxBackup: {
        id: args.backup.id,
        dir: args.backup.dir,
        localBucket: args.backup.localBucket,
        updatedAt: args.now,
      },
    });
  },
});

export const markSandboxRunTimedOut = internalMutation({
  args: {
    runId: v.id('analystSandboxRuns'),
    error: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) return false;
    if (!isActiveSandboxRunStatus(run.status)) return false;

    const seq = run.nextSeq;
    await ctx.db.insert('analystSandboxRunEvents', {
      runId: args.runId,
      analystThreadId: run.analystThreadId,
      creatorUserId: run.creatorUserId,
      orgId: run.orgId,
      seq,
      type: 'error',
      message: args.error,
      data: {
        status: 'timed_out',
        deadlineMs: sandboxRunDeadlineMs(run),
        lastEventAt: run.lastEventAt,
      },
      emittedAt: args.now,
    });

    await ctx.db.patch(args.runId, {
      status: 'timed_out',
      error: args.error,
      completedAt: args.now,
      lastEventAt: args.now,
      updatedAt: args.now,
      nextSeq: seq + 1,
    });

    return true;
  },
});

export const markSandboxContinuationScheduled = internalMutation({
  args: {
    runId: v.id('analystSandboxRuns'),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || !shouldScheduleContinuation(run)) return false;
    await ctx.db.patch(args.runId, {
      continuationScheduledAt: args.now,
      updatedAt: args.now,
    });
    return true;
  },
});

export const recordSandboxControl = internalMutation({
  args: {
    runId: v.id('analystSandboxRuns'),
    userId: v.id('users'),
    action: sandboxControlActionValidator,
    message: v.optional(v.string()),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (run?.creatorUserId !== args.userId) throw new Error('Pi run not found');
    // A cancel that arrives after the run already finished must not clobber its terminal status.
    const cancelling = args.action === 'cancel' && isActiveSandboxRunStatus(run.status);
    await ctx.db.insert('analystSandboxRunEvents', {
      runId: args.runId,
      analystThreadId: run.analystThreadId,
      creatorUserId: run.creatorUserId,
      orgId: run.orgId,
      seq: run.nextSeq,
      type: 'control',
      message: truncateText(args.message ?? args.action, MAX_SANDBOX_EVENT_MESSAGE_CHARS),
      data: { action: args.action },
      emittedAt: args.now,
    });
    await ctx.db.patch(args.runId, {
      status: cancelling ? 'cancelled' : run.status,
      nextSeq: run.nextSeq + 1,
      lastEventAt: args.now,
      completedAt: cancelling ? args.now : run.completedAt,
      updatedAt: args.now,
    });
  },
});
