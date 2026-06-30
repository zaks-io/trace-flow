import { v } from 'convex/values';

/**
 * Single source of truth for the Pi sandbox run/event table shapes and enums.
 * `schema.ts` builds the tables from these, and the sandbox action/mutation args
 * reuse the same validators so the status/event-type unions are defined once.
 */

export const sandboxRunStatus = v.union(
  v.literal('queued'),
  v.literal('starting'),
  v.literal('running'),
  v.literal('completed'),
  v.literal('failed'),
  v.literal('timed_out'),
  v.literal('cancelled'),
);

/** Terminal statuses a run callback may report. */
export const sandboxRunTerminalStatus = v.union(
  v.literal('completed'),
  v.literal('failed'),
  v.literal('timed_out'),
  v.literal('cancelled'),
);

export const sandboxRunEventType = v.union(
  v.literal('status'),
  v.literal('stdout'),
  v.literal('stderr'),
  v.literal('message'),
  v.literal('tool_call'),
  v.literal('tool_result'),
  v.literal('result'),
  v.literal('error'),
  v.literal('control'),
  v.literal('usage'),
);

/** A backup handle to a /workspace snapshot stored in R2. */
export const sandboxBackupHandle = v.object({
  id: v.string(),
  dir: v.string(),
  localBucket: v.optional(v.boolean()),
});

/** The last cumulative usage snapshot already folded into the ledger for a run. */
export const sandboxUsageApplied = v.object({
  totalTokens: v.number(),
  totalCost: v.number(),
  cacheReadTokens: v.number(),
});

export const sandboxRunFields = {
  analystThreadId: v.id('analystThreads'),
  creatorUserId: v.id('users'),
  orgId: v.id('organizations'),
  sandboxId: v.string(),
  processId: v.optional(v.string()),
  prompt: v.string(),
  pageContextReferences: v.optional(v.array(v.any())),
  status: sandboxRunStatus,
  runTokenHash: v.string(),
  maxRuntimeMs: v.number(),
  updatedAt: v.number(),
  startedAt: v.optional(v.number()),
  completedAt: v.optional(v.number()),
  lastEventAt: v.optional(v.number()),
  nextSeq: v.number(),
  resultText: v.optional(v.string()),
  error: v.optional(v.string()),
  continuationScheduledAt: v.optional(v.number()),
  // How many times this run has already been auto-resumed after a dead container.
  // Carried forward across resumes and capped so a crash-looping run fails loudly.
  resumeAttempt: v.optional(v.number()),
  // Last cumulative usage snapshot already folded into the usage ledger for this run.
  // Pi emits cumulative snapshots; we add only the delta so resumes/restreams don't
  // double-count. Absent = nothing applied yet.
  usageApplied: v.optional(sandboxUsageApplied),
};

export const sandboxRunEventFields = {
  runId: v.id('analystSandboxRuns'),
  analystThreadId: v.id('analystThreads'),
  creatorUserId: v.id('users'),
  orgId: v.id('organizations'),
  seq: v.number(),
  type: sandboxRunEventType,
  message: v.optional(v.string()),
  data: v.optional(v.any()),
  emittedAt: v.number(),
};

/** Shape the sandbox runner posts back for a single event (seq + ids are assigned server-side). */
export const sandboxRunEventInput = v.object({
  type: sandboxRunEventType,
  message: v.optional(v.string()),
  data: v.optional(v.any()),
  emittedAt: v.optional(v.number()),
});
