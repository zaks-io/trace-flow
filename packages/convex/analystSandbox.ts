import { createTool, type ToolCtx as AgentToolCtx } from '@convex-dev/agent';
import {
  dispatchToolCall,
  getTraceFlowToolDefinitions,
  LATEST_PROTOCOL_VERSION,
  type ToolCallParams,
  type ToolCallResult,
} from '@trace-flow/mcp-core';
import { v } from 'convex/values';
import { z } from 'zod/v4';
import { toPiRunRows } from './analystPiRows';
import { createMcpBackend } from './mcp/backend';
import { sandboxRunEventInput } from './analystSandboxSchema';
import {
  buildSandboxControlEvents,
  describeSandboxProcessCause,
  isActiveSandboxRunStatus,
  isSandboxRunTimeoutExpired,
  planDeadRunRecovery,
  sandboxRunLivenessVerdict,
  sandboxRunTimeoutRemainingMs,
  SANDBOX_MAX_RESUME_ATTEMPTS,
  SANDBOX_TIMEOUT_WATCHDOG_GRACE_MS,
  type SandboxControlResponse,
} from './analystSandboxPolicy';
import {
  ANALYST_MODEL,
  buildPiCompletionPrompt,
  getEnabledActionUser,
  getEnabledUserById,
  getOwnedThread,
  requireAnalystProEntitlement,
  type PageContextReference,
} from './analyst';
import { action, internalAction, internalMutation, query } from './_generated/server';
import type { ActionCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { DataModel, Doc, Id } from './_generated/dataModel';
import { requireEnabledUser } from './auth/users';
import {
  buildPiSandboxId,
  clampPiRuntimeMs,
  createSandboxRunToken,
  MAX_PROMPT_CHARS,
  MAX_SANDBOX_EVENT_BATCH,
  MAX_SANDBOX_EVENT_MESSAGE_CHARS,
  MAX_SANDBOX_RESULT_CHARS,
  normalizeUnknownPageContextReferences,
  SANDBOX_START_FETCH_TIMEOUT_MS,
  sha256Hex,
  summarizeSandboxRun,
  truncateText,
} from './analystSandboxRun';

export { SANDBOX_START_FETCH_TIMEOUT_MS, truncateText };

const TINYBIRD_BASE_URL = process.env.TINYBIRD_API_URL ?? 'https://api.us-west-2.aws.tinybird.co';
const SANDBOX_CONTROL_FETCH_TIMEOUT_MS = 30_000;
const SANDBOX_TIMEOUT_RESCHEDULE_PADDING_MS = 10_000;
// Liveness watchdog reschedule cadence. Staleness threshold + resume cap live in policy.
const SANDBOX_LIVENESS_CHECK_INTERVAL_MS = 30_000;
// A cold container can take longer than one interval to pull, boot, and emit its
// first heartbeat. Don't run the first liveness check until after that window so a
// legitimately-slow start isn't mistaken for a dead container.
const SANDBOX_LIVENESS_FIRST_CHECK_MS = 90_000;

const sandboxTraceFlowToolDefinitions = getTraceFlowToolDefinitions('analyst');

export function getDirectAnalystTraceFlowToolDefinitions(): typeof sandboxTraceFlowToolDefinitions {
  return [];
}

function getToolErrorMessage(result: ToolCallResult): string | null {
  if (!result.isError) return null;
  return result.content.map((part) => part.text ?? part.data ?? '').join('\n') || 'Tool failed';
}

async function runTraceFlowTool(
  ctx: ActionCtx,
  userId: Id<'users'>,
  params: ToolCallParams,
): Promise<ToolCallResult> {
  const response = await dispatchToolCall(
    createMcpBackend(ctx, userId),
    TINYBIRD_BASE_URL,
    Date.now(),
    params,
    LATEST_PROTOCOL_VERSION,
    'analyst',
  );

  if (response.error) {
    throw new Error(response.error.message);
  }

  const result = response.result as ToolCallResult;
  const error = getToolErrorMessage(result);
  if (error) {
    throw new Error(error);
  }
  return result;
}

async function resolveToolUser(ctx: AgentToolCtx<DataModel>): Promise<Doc<'users'>> {
  if (ctx.userId) {
    return getEnabledUserById(ctx, ctx.userId as Id<'users'>);
  }
  return getEnabledActionUser(ctx);
}

export function shouldExposeSandboxControlTool(prompt: string) {
  return /\b(cancel|status|tail|inspect|check|steer|follow[- ]?up|run id|pi run|sandbox run)\b/i.test(
    prompt,
  );
}

export function buildAnalystTools(options: { allowSandboxControl?: boolean } = {}) {
  const tools = {
    start_pi_agent_analysis: createTool({
      description:
        'Start a long-running asynchronous run of the Trace Flow data analysis agent. Use for nuanced or exploratory Trace Flow data questions that may need many data queries or Python work. The agent is narrow: its only job is to analyze Trace Flow data and it will decline anything else, so relay only the data question and do not ask it for code edits, repository work, infrastructure, web access, or non-data tasks. Frame the prompt as a data-analysis task: write scripts, call the sandbox-local REST/OpenAPI data API, page and save raw responses to disk, compute summaries/aggregates locally, and validate before answering. Do not ask it to inspect or paste raw datasets into model context. For /app/agents and Agent Analytics context, tell it to use query_agent_analytics through the sandbox-local REST/OpenAPI data API; for simple 7-day KPI summaries, pass {"view":"summary","hours":168} directly and do not ask it to perform schema discovery first. This is async: after this tool returns, wait for the completion continuation before giving the final data answer. Do not call control_pi_agent_run just to wait. The UI streams progress and Convex will notify this conversation when the run completes.',
      inputSchema: z.object({
        prompt: z.string().min(1).max(MAX_PROMPT_CHARS),
        pageContextReferences: z.array(z.object({}).catchall(z.unknown())).optional(),
        maxRuntimeMinutes: z.number().min(1).max(120).optional(),
      }),
      execute: async (ctx: AgentToolCtx<DataModel>, input) => {
        const user = await resolveToolUser(ctx);
        return startPiAgentAnalysis(ctx, user._id, {
          prompt: input.prompt,
          pageContextReferences: input.pageContextReferences,
          maxRuntimeMinutes: input.maxRuntimeMinutes,
          agentThreadId: ctx.threadId,
        });
      },
    }),
  };

  if (!options.allowSandboxControl) return tools;

  return {
    ...tools,
    control_pi_agent_run: createTool({
      description:
        'Steer, debug, inspect, cancel, or add follow-up instructions to an existing asynchronous Trace Flow data analysis run. This is not the normal wait path after start_pi_agent_analysis. Do not poll a run you just started unless the user explicitly asks for debug/status/tail inspection.',
      inputSchema: z.object({
        runId: z.string().min(1),
        action: z.enum(['status', 'tail', 'cancel', 'steer', 'follow_up']),
        message: z.string().max(8_000).optional(),
        tailLimit: z.number().int().min(1).max(100).optional(),
      }),
      execute: async (ctx: AgentToolCtx<DataModel>, input) => {
        const user = await resolveToolUser(ctx);
        return controlPiAgentRun(ctx, user._id, input);
      },
    }),
  };
}

async function postSandboxJson(
  path: string,
  body: unknown,
  timeoutMs = SANDBOX_CONTROL_FETCH_TIMEOUT_MS,
) {
  const sandboxUrl = process.env.ANALYST_SANDBOX_URL;
  const sandboxSecret = process.env.ANALYST_SANDBOX_SHARED_SECRET;
  if (!sandboxUrl || !sandboxSecret) {
    throw new Error('Analyst sandbox is not configured.');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(new URL(path, sandboxUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${sandboxSecret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const json = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(
        typeof json === 'object' && json && 'error' in json
          ? String(json.error)
          : `Sandbox returned ${response.status}`,
      );
    }
    return json;
  } finally {
    clearTimeout(timeout);
  }
}

async function startPiAgentAnalysis(
  ctx: ActionCtx,
  userId: Id<'users'>,
  input: {
    prompt: string;
    pageContextReferences?: unknown;
    maxRuntimeMinutes?: number;
    agentThreadId?: string;
  },
) {
  if (!input.agentThreadId) {
    return { ok: false, error: 'Analyst thread is not available for this tool call.' };
  }

  const thread = await ctx.runQuery(internal.analyst.getThreadByAgentThreadIdForAction, {
    agentThreadId: input.agentThreadId,
    userId,
  });
  if (!thread) return { ok: false, error: 'Conversation not found.' };

  const launched = await launchSandboxRun(ctx, {
    analystThreadId: thread._id,
    creatorUserId: userId,
    orgId: thread.orgId,
    prompt: input.prompt,
    pageContextReferences: normalizeUnknownPageContextReferences(input.pageContextReferences),
    maxRuntimeMs: clampPiRuntimeMs(input.maxRuntimeMinutes),
    // Resume this conversation's prior sandbox: a fresh DO restores the last /workspace
    // snapshot from R2 so Pi continues its session instead of re-downloading from zero.
    backup: thread.sandboxBackup ?? null,
    resumeAttempt: 0,
  });

  if (!launched.ok) {
    return {
      ok: false,
      type: 'async_pi_agent_run',
      runId: launched.runId,
      status: 'failed',
      error: launched.error,
    };
  }

  return {
    ok: true,
    type: 'async_pi_agent_run',
    async: true,
    runId: launched.runId,
    status: 'running',
    resumed: launched.resumed,
    maxRuntimeMinutes: Math.round(launched.maxRuntimeMs / 60_000),
    message: launched.resumed
      ? 'Trace Flow data analysis resumed from this conversation’s prior sandbox session. The UI will stream progress and this conversation will be notified when it completes.'
      : 'Trace Flow data analysis started in a new sandbox. The UI will stream progress and this conversation will be notified when it completes.',
  };
}

interface LaunchSandboxRunInput {
  analystThreadId: Id<'analystThreads'>;
  creatorUserId: Id<'users'>;
  orgId: Id<'organizations'>;
  prompt: string;
  pageContextReferences: PageContextReference[];
  maxRuntimeMs: number;
  backup: { id: string; dir: string; localBucket?: boolean } | null;
  resumeAttempt: number;
}

type LaunchSandboxRunResult =
  | { ok: true; runId: Id<'analystSandboxRuns'>; resumed: boolean; maxRuntimeMs: number }
  | { ok: false; runId: Id<'analystSandboxRuns'>; error: string };

/**
 * Create a sandbox run, arm its watchdogs (deadline + liveness), POST it to the
 * sandbox worker, and mark it started. Shared by the initial tool call and the
 * dead-container auto-resume path so both arm liveness identically.
 */
async function launchSandboxRun(
  ctx: ActionCtx,
  input: LaunchSandboxRunInput,
): Promise<LaunchSandboxRunResult> {
  await requireAnalystProEntitlement(ctx, input.orgId);

  const { token, hash } = await createSandboxRunToken();
  const now = Date.now();
  const sandboxId = buildPiSandboxId();
  const resumed = Boolean(input.backup);
  const runId = await ctx.runMutation(internal.analystSandboxStore.createSandboxRun, {
    analystThreadId: input.analystThreadId,
    creatorUserId: input.creatorUserId,
    orgId: input.orgId,
    sandboxId,
    prompt: input.prompt,
    pageContextReferences: input.pageContextReferences,
    runTokenHash: hash,
    maxRuntimeMs: input.maxRuntimeMs,
    resumeAttempt: input.resumeAttempt,
    now,
  });
  // Backstop deadline watchdog (hours) plus the fast liveness watchdog (30s) that
  // catches a dead container long before the deadline.
  await ctx.scheduler.runAfter(
    input.maxRuntimeMs + SANDBOX_TIMEOUT_WATCHDOG_GRACE_MS,
    internal.analystSandbox.timeoutSandboxRunIfExpired,
    { runId },
  );
  await ctx.scheduler.runAfter(
    SANDBOX_LIVENESS_FIRST_CHECK_MS,
    internal.analystSandbox.resumeOrFailStaleSandboxRun,
    { runId },
  );

  try {
    const started = (await postSandboxJson(
      '/pi-runs/start',
      {
        runId,
        runToken: token,
        sandboxId,
        prompt: input.prompt,
        pageContextReferences: input.pageContextReferences,
        maxRuntimeMs: input.maxRuntimeMs,
        model: ANALYST_MODEL,
        toolDefinitions: sandboxTraceFlowToolDefinitions,
        resume: resumed,
        backup: input.backup
          ? { id: input.backup.id, dir: input.backup.dir, localBucket: input.backup.localBucket }
          : undefined,
      },
      SANDBOX_START_FETCH_TIMEOUT_MS,
    )) as { processId?: string };

    await ctx.runMutation(internal.analystSandboxStore.markSandboxRunStarted, {
      runId,
      userId: input.creatorUserId,
      processId: started.processId,
      now: Date.now(),
    });

    return { ok: true, runId, resumed, maxRuntimeMs: input.maxRuntimeMs };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.runMutation(internal.analystSandboxStore.completeSandboxRunInternal, {
      runId,
      tokenHash: hash,
      status: 'failed',
      error: message,
      now: Date.now(),
    });
    return { ok: false, runId, error: message };
  }
}

async function controlPiAgentRun(
  ctx: ActionCtx,
  userId: Id<'users'>,
  input: {
    runId: string;
    action: 'status' | 'tail' | 'cancel' | 'steer' | 'follow_up';
    message?: string;
    tailLimit?: number;
  },
) {
  const runId = input.runId as Id<'analystSandboxRuns'>;
  let run = await ctx.runQuery(internal.analystSandboxStore.getOwnedSandboxRunForAction, {
    runId,
    userId,
  });
  if (!run) return { ok: false, error: 'Pi run not found.' };

  if (isSandboxRunTimeoutExpired(run, Date.now())) {
    await ctx.runMutation(internal.analystSandbox.timeoutSandboxRunIfExpired, { runId });
    run = await ctx.runQuery(internal.analystSandboxStore.getOwnedSandboxRunForAction, {
      runId,
      userId,
    });
    if (!run) return { ok: false, error: 'Pi run not found.' };
  }

  if ((input.action === 'steer' || input.action === 'follow_up') && !input.message?.trim()) {
    return { ok: false, error: `${input.action} requires a message.` };
  }

  if (input.action === 'steer' || input.action === 'follow_up') {
    await requireAnalystProEntitlement(ctx, run.orgId);
  }

  const events =
    input.action === 'tail'
      ? await ctx.runQuery(internal.analystSandboxStore.getSandboxRunEventsForAction, {
          runId,
          userId,
          limit: input.tailLimit ?? 25,
        })
      : undefined;

  const sandboxResponse = (await postSandboxJson('/pi-runs/control', {
    runId,
    sandboxId: run.sandboxId,
    processId: run.processId,
    action: input.action,
    message: input.message,
    tailLimit: input.tailLimit,
  })) as SandboxControlResponse;

  const now = Date.now();
  if (input.action !== 'status' && input.action !== 'tail') {
    await ctx.runMutation(internal.analystSandboxStore.recordSandboxControl, {
      runId,
      userId,
      action: input.action,
      message: input.message,
      now,
    });
  }

  const diagnosticEvents = buildSandboxControlEvents(run, sandboxResponse);
  if (diagnosticEvents.length > 0) {
    await ctx.runMutation(internal.analystSandboxStore.appendSandboxRunEvents, {
      runId,
      tokenHash: run.runTokenHash,
      events: diagnosticEvents,
      now: Date.now(),
    });
  }

  return {
    ok: true,
    runId,
    action: input.action,
    status: input.action === 'cancel' ? 'cancelled' : run.status,
    sandbox: sandboxResponse,
    run: summarizeSandboxRun(run),
    events,
  };
}

export async function cancelSandboxRunBestEffort(
  ctx: ActionCtx,
  userId: Id<'users'>,
  run: Doc<'analystSandboxRuns'>,
) {
  let sandboxResponse: SandboxControlResponse | null = null;
  let error: string | undefined;

  try {
    sandboxResponse = (await postSandboxJson(
      '/pi-runs/control',
      {
        runId: run._id,
        sandboxId: run.sandboxId,
        processId: run.processId,
        action: 'cancel',
      },
      10_000,
    )) as SandboxControlResponse;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const now = Date.now();
  await ctx.runMutation(internal.analystSandboxStore.recordSandboxControl, {
    runId: run._id,
    userId,
    action: 'cancel',
    message: error ? `cancel requested; sandbox control failed: ${error}` : 'cancel requested',
    now,
  });

  const events = sandboxResponse
    ? buildSandboxControlEvents(run, sandboxResponse)
    : [
        {
          type: 'stderr' as const,
          message: `Sandbox cancellation was recorded, but Worker control failed: ${error ?? 'unknown error'}.`,
          data: { action: 'cancel', error },
        },
      ];
  if (events.length > 0) {
    await ctx.runMutation(internal.analystSandboxStore.appendSandboxRunEvents, {
      runId: run._id,
      tokenHash: run.runTokenHash,
      events,
      now: Date.now(),
    });
  }

  return {
    ok: !error,
    runId: run._id,
    action: 'cancel' as const,
    status: 'cancelled' as const,
    error,
    sandbox: sandboxResponse,
  };
}

/**
 * Pull the container's exit code + stderr/stdout the instant a watchdog declares a run dead,
 * and write them into the run's event log. This is the out-of-band post-mortem that does NOT
 * depend on the (possibly-killed) runner reporting anything: it reads getProcess/getProcessLogs
 * directly via /pi-runs/control. Returns a one-line cause for the terminal error message, e.g.
 * "process pi-... is killed with exit code 137" — so "timed out" stops being a mystery.
 */
async function captureSandboxPostMortem(
  ctx: ActionCtx,
  run: Doc<'analystSandboxRuns'>,
): Promise<{ cause?: string; exitCode?: number; processStatus?: string }> {
  let snapshot: SandboxControlResponse | null = null;
  let fetchError: string | undefined;
  try {
    snapshot = (await postSandboxJson(
      '/pi-runs/control',
      {
        runId: run._id,
        sandboxId: run.sandboxId,
        processId: run.processId,
        action: 'status',
      },
      10_000,
    )) as SandboxControlResponse;
  } catch (err) {
    fetchError = err instanceof Error ? err.message : String(err);
  }

  const events = snapshot
    ? buildSandboxControlEvents(run, snapshot)
    : [
        {
          type: 'stderr' as const,
          message: `Could not read sandbox process diagnostics: ${fetchError ?? 'unknown error'}.`,
          data: { reason: 'post_mortem_fetch_failed', error: fetchError },
        },
      ];
  if (events.length > 0) {
    await ctx.runMutation(internal.analystSandboxStore.appendSandboxRunEvents, {
      runId: run._id,
      tokenHash: run.runTokenHash,
      events,
      now: Date.now(),
    });
  }

  const process = snapshot?.process ?? null;
  const processStatus = process?.status ?? undefined;
  const exitCode = typeof process?.exitCode === 'number' ? process.exitCode : undefined;
  const cause = describeSandboxProcessCause(process, run.processId, fetchError);
  return { cause, exitCode, processStatus };
}

export const listSandboxRuns = query({
  args: { threadId: v.id('analystThreads') },
  handler: async (ctx, args) => {
    const user = await requireEnabledUser(ctx);
    const thread = await getOwnedThread(ctx, user._id, args.threadId);
    if (!thread) throw new Error('Conversation not found');

    const runs = await ctx.db
      .query('analystSandboxRuns')
      .withIndex('by_thread_updated', (q) => q.eq('analystThreadId', args.threadId))
      .collect();

    return runs
      .filter((run) => run.creatorUserId === user._id)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 10)
      .map(summarizeSandboxRun);
  },
});

export const getSandboxRun = query({
  args: { runId: v.id('analystSandboxRuns') },
  handler: async (ctx, args) => {
    const user = await requireEnabledUser(ctx);
    const run = await ctx.db.get(args.runId);
    if (run?.creatorUserId !== user._id) throw new Error('Pi run not found');
    return summarizeSandboxRun(run);
  },
});

export const listSandboxRunEvents = query({
  args: {
    runId: v.id('analystSandboxRuns'),
    afterSeq: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const user = await requireEnabledUser(ctx);
    const run = await ctx.db.get(args.runId);
    if (run?.creatorUserId !== user._id) throw new Error('Pi run not found');

    const limit = Math.min(Math.max(args.limit ?? 100, 1), 200);
    const events = await ctx.db
      .query('analystSandboxRunEvents')
      .withIndex('by_run_seq', (q) => q.eq('runId', args.runId))
      .filter((q) =>
        args.afterSeq === undefined
          ? q.gte(q.field('seq'), 0)
          : q.gt(q.field('seq'), args.afterSeq),
      )
      .collect();

    const sorted = events.sort((a, b) => a.seq - b.seq);
    return args.afterSeq === undefined ? sorted.slice(-limit) : sorted.slice(0, limit);
  },
});

/**
 * Presentation-ready work-log rows for a Pi run. The server groups the ordered
 * events (merges tool start/end, collapses usage, drops noise) so the client is
 * a dumb render loop — the same contract as `listMessages` for chat.
 */
export const listSandboxRunRows = query({
  args: { runId: v.id('analystSandboxRuns'), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const user = await requireEnabledUser(ctx);
    const run = await ctx.db.get(args.runId);
    if (run?.creatorUserId !== user._id) throw new Error('Pi run not found');

    const limit = Math.min(Math.max(args.limit ?? 200, 1), 400);
    const events = await ctx.db
      .query('analystSandboxRunEvents')
      .withIndex('by_run_seq', (q) => q.eq('runId', args.runId))
      .collect();

    const sorted = events.sort((a, b) => a.seq - b.seq).slice(-limit);
    return toPiRunRows(
      sorted.map((event) => ({
        _id: event._id,
        seq: event.seq,
        type: event.type,
        message: event.message,
        data: event.data,
        emittedAt: event.emittedAt,
      })),
    );
  },
});

export const cancelSandboxRun = action({
  args: { runId: v.id('analystSandboxRuns') },
  handler: async (ctx, args) => {
    const user = await getEnabledActionUser(ctx);
    let run = await ctx.runQuery(internal.analystSandboxStore.getOwnedSandboxRunForAction, {
      runId: args.runId,
      userId: user._id,
    });
    if (!run) throw new Error('Pi run not found');

    if (isSandboxRunTimeoutExpired(run, Date.now())) {
      await ctx.runMutation(internal.analystSandbox.timeoutSandboxRunIfExpired, {
        runId: args.runId,
      });
      run = await ctx.runQuery(internal.analystSandboxStore.getOwnedSandboxRunForAction, {
        runId: args.runId,
        userId: user._id,
      });
      if (!run) throw new Error('Pi run not found');
    }

    if (!isActiveSandboxRunStatus(run.status)) {
      return {
        ok: true,
        runId: args.runId,
        action: 'cancel' as const,
        status: run.status,
        run: summarizeSandboxRun(run),
      };
    }

    return cancelSandboxRunBestEffort(ctx, user._id, run);
  },
});

export const cleanupSandboxRunContainer = action({
  args: { runId: v.id('analystSandboxRuns') },
  handler: async (ctx, args) => {
    const user = await getEnabledActionUser(ctx);
    const run = await ctx.runQuery(internal.analystSandboxStore.getOwnedSandboxRunForAction, {
      runId: args.runId,
      userId: user._id,
    });
    if (!run) throw new Error('Pi run not found');

    let error: string | undefined;
    try {
      await postSandboxJson(
        '/pi-runs/destroy',
        {
          sandboxId: run.sandboxId,
          processId: run.processId,
        },
        20_000,
      );
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    await ctx.runMutation(internal.analystSandboxStore.appendSandboxRunEvents, {
      runId: run._id,
      tokenHash: run.runTokenHash,
      events: [
        {
          type: 'control',
          message: error
            ? `Sandbox cleanup failed: ${error}`
            : 'Sandbox container cleanup completed.',
          data: { action: 'cleanup', error },
        },
      ],
      now: Date.now(),
    });

    return {
      ok: !error,
      runId: run._id,
      sandboxId: run.sandboxId,
      error,
    };
  },
});

export const refreshSandboxRunStatus = action({
  args: { runId: v.id('analystSandboxRuns') },
  handler: async (ctx, args) => {
    const user = await getEnabledActionUser(ctx);
    const run = await ctx.runQuery(internal.analystSandboxStore.getOwnedSandboxRunForAction, {
      runId: args.runId,
      userId: user._id,
    });
    if (!run) throw new Error('Pi run not found');

    if (isSandboxRunTimeoutExpired(run, Date.now())) {
      await ctx.runMutation(internal.analystSandbox.timeoutSandboxRunIfExpired, {
        runId: args.runId,
      });
      const updated = await ctx.runQuery(internal.analystSandboxStore.getOwnedSandboxRunForAction, {
        runId: args.runId,
        userId: user._id,
      });
      return updated ? summarizeSandboxRun(updated) : null;
    }

    return summarizeSandboxRun(run);
  },
});

export const verifySandboxRunToken = action({
  args: {
    runId: v.id('analystSandboxRuns'),
    token: v.string(),
    purpose: v.optional(v.union(v.literal('inference'), v.literal('callback'))),
  },
  handler: async (ctx, args) => {
    const tokenHash = await sha256Hex(args.token);
    const run = await ctx.runQuery(internal.analystSandboxStore.getVerifiedSandboxRunForAction, {
      runId: args.runId,
      tokenHash,
    });
    if (run && args.purpose === 'inference') {
      await requireAnalystProEntitlement(ctx, run.orgId);
    }
    return { ok: Boolean(run), status: run?.status ?? null };
  },
});

export const receiveSandboxEvents = action({
  args: {
    runId: v.id('analystSandboxRuns'),
    token: v.string(),
    events: v.array(sandboxRunEventInput),
  },
  handler: async (ctx, args) => {
    const tokenHash = await sha256Hex(args.token);
    await ctx.runMutation(internal.analystSandboxStore.appendSandboxRunEvents, {
      runId: args.runId,
      tokenHash,
      events: args.events.slice(0, MAX_SANDBOX_EVENT_BATCH).map((event) => ({
        ...event,
        message: truncateText(event.message, MAX_SANDBOX_EVENT_MESSAGE_CHARS),
      })),
      now: Date.now(),
    });
    return { ok: true };
  },
});

export const completeSandboxRun = action({
  args: {
    runId: v.id('analystSandboxRuns'),
    token: v.string(),
    status: v.union(
      v.literal('completed'),
      v.literal('failed'),
      v.literal('timed_out'),
      v.literal('cancelled'),
    ),
    resultText: v.optional(v.string()),
    error: v.optional(v.string()),
    backup: v.optional(
      v.object({ id: v.string(), dir: v.string(), localBucket: v.optional(v.boolean()) }),
    ),
  },
  handler: async (ctx, args) => {
    const tokenHash = await sha256Hex(args.token);
    await ctx.runMutation(internal.analystSandboxStore.completeSandboxRunInternal, {
      runId: args.runId,
      tokenHash,
      status: args.status,
      resultText: truncateText(args.resultText, MAX_SANDBOX_RESULT_CHARS),
      error: truncateText(args.error, MAX_SANDBOX_EVENT_MESSAGE_CHARS),
      now: Date.now(),
    });

    // Persist the fresh /workspace snapshot on the conversation so the next Pi run rehydrates
    // and resumes. The runner only sends a backup handle when it has a usable snapshot;
    // storeThreadSandboxBackup guards against a stale write clobbering a fresher checkpoint.
    if (args.backup) {
      await ctx.runMutation(internal.analystSandboxStore.storeThreadSandboxBackup, {
        runId: args.runId,
        tokenHash,
        backup: args.backup,
        now: Date.now(),
      });
    }

    if (args.status === 'completed') {
      const scheduled = await ctx.runMutation(
        internal.analystSandboxStore.markSandboxContinuationScheduled,
        {
          runId: args.runId,
          now: Date.now(),
        },
      );
      if (scheduled) {
        await ctx.scheduler.runAfter(0, internal.analystSandbox.continueAfterSandboxRun, {
          runId: args.runId,
        });
      }
    }

    return { ok: true };
  },
});

/**
 * Store a mid-run /workspace snapshot on the conversation without ending the run.
 * Called best-effort from the runner's session_shutdown hook so a graceful container
 * teardown (deploy rollout) leaves a fresh checkpoint for auto-resume.
 */
export const checkpointSandboxRun = action({
  args: {
    runId: v.id('analystSandboxRuns'),
    token: v.string(),
    backup: v.object({ id: v.string(), dir: v.string(), localBucket: v.optional(v.boolean()) }),
  },
  handler: async (ctx, args) => {
    const tokenHash = await sha256Hex(args.token);
    await ctx.runMutation(internal.analystSandboxStore.storeThreadSandboxBackup, {
      runId: args.runId,
      tokenHash,
      backup: args.backup,
      now: Date.now(),
    });
    return { ok: true };
  },
});

export const executeSandboxToolCall = action({
  args: {
    runId: v.id('analystSandboxRuns'),
    token: v.string(),
    toolName: v.string(),
    arguments: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const tokenHash = await sha256Hex(args.token);
    const run = await ctx.runQuery(internal.analystSandboxStore.getVerifiedSandboxRunForAction, {
      runId: args.runId,
      tokenHash,
    });
    if (!run) throw new Error('Pi run not found');
    if (!['queued', 'starting', 'running'].includes(run.status)) {
      throw new Error(`Pi run is ${run.status}`);
    }

    const user = await getEnabledUserById(ctx, run.creatorUserId);
    await requireAnalystProEntitlement(ctx, run.orgId);

    // The work log is built from the runner's own clean tool rows (the agent's
    // bash/read steps). The data-fetch endpoint used to also write tool_call /
    // tool_result trace rows here — a redundant second track — so we no longer do.
    // We persist only a failure, as a clean error the work log surfaces.
    let result: ToolCallResult;
    try {
      result = await runTraceFlowTool(ctx, user._id, {
        name: args.toolName,
        arguments: (args.arguments as Record<string, unknown> | undefined) ?? {},
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.runMutation(internal.analystSandboxStore.appendSandboxRunEvents, {
        runId: args.runId,
        tokenHash,
        events: [
          {
            type: 'error',
            message: `Trace Flow data tool ${args.toolName} failed: ${message}`,
            emittedAt: Date.now(),
          },
        ],
        now: Date.now(),
      });
      throw error;
    }

    return { ok: true, result };
  },
});

export const continueAfterSandboxRun = internalAction({
  args: { runId: v.id('analystSandboxRuns') },
  handler: async (ctx, args) => {
    const run = await ctx.runQuery(internal.analystSandboxStore.getSandboxRunForAction, {
      runId: args.runId,
    });
    if (run?.status !== 'completed' || !run.resultText) return;

    await getEnabledUserById(ctx, run.creatorUserId);
    await requireAnalystProEntitlement(ctx, run.orgId);
    await ctx.runAction(internal.analyst.streamMessage, {
      threadId: run.analystThreadId,
      userId: run.creatorUserId,
      prompt: buildPiCompletionPrompt(run),
      pageContextReferences: [],
      hiddenPrompt: true,
      stopBaselineAt: Date.now(),
    });
  },
});

export const timeoutSandboxRunIfExpired = internalMutation({
  args: {
    runId: v.id('analystSandboxRuns'),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    const now = Date.now();
    if (!run) return false;

    const remainingMs = sandboxRunTimeoutRemainingMs(run, now);
    if (remainingMs === null) return false;
    if (remainingMs > 0) {
      await ctx.scheduler.runAfter(
        remainingMs + SANDBOX_TIMEOUT_RESCHEDULE_PADDING_MS,
        internal.analystSandbox.timeoutSandboxRunIfExpired,
        { runId: args.runId },
      );
      return false;
    }

    // Expired with no completion callback. A mutation can't fetch the container's exit code, so
    // hand off to an action that pulls the post-mortem (exit code + stderr) BEFORE stamping the
    // run terminal — so "timed out" carries why (e.g. exit 137 = OOM) instead of being a mystery.
    await ctx.scheduler.runAfter(0, internal.analystSandbox.reapTimedOutSandboxRun, {
      runId: args.runId,
    });
    return true;
  },
});

/**
 * Stamp an expired run timed_out, but first pull the container post-mortem (exit code + stderr
 * tail) so the terminal error explains the death. Runs as an action because the timeout mutation
 * cannot fetch. Re-checks expiry under the action so a run that completed in the gap is left alone.
 */
export const reapTimedOutSandboxRun = internalAction({
  args: { runId: v.id('analystSandboxRuns') },
  handler: async (ctx, args) => {
    const run = await ctx.runQuery(internal.analystSandboxStore.getSandboxRunForReap, {
      runId: args.runId,
    });
    if (!run) return;
    if (!isSandboxRunTimeoutExpired(run, Date.now())) return;

    let cause: string | undefined;
    try {
      ({ cause } = await captureSandboxPostMortem(ctx, run));
    } catch (error) {
      console.error('reapTimedOutSandboxRun post-mortem failed', {
        runId: args.runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const base =
      'Run exceeded its configured max runtime and the sandbox did not send a completion callback.';
    const error = cause ? `${base} Sandbox ${cause}.` : base;
    await ctx.runMutation(internal.analystSandboxStore.markSandboxRunTimedOut, {
      runId: args.runId,
      error,
      now: Date.now(),
    });
  },
});

/**
 * Fast liveness watchdog (every 30s). The runner heartbeats every ~10s, so if a
 * run is still active but hasn't emitted for 30s its container is dead (deploy
 * rollout, eviction, crash). Marks the dead run interrupted and auto-resumes from
 * the conversation's last R2 checkpoint — up to SANDBOX_MAX_RESUME_ATTEMPTS, then
 * fails loudly. Healthy runs simply reschedule the next check.
 */
export const resumeOrFailStaleSandboxRun = internalAction({
  args: { runId: v.id('analystSandboxRuns') },
  handler: async (ctx, args) => {
    const context = await ctx.runQuery(internal.analystSandboxStore.getSandboxRunLivenessContext, {
      runId: args.runId,
    });
    if (!context) return;
    const { run, backup } = context;

    const now = Date.now();
    const verdict = sandboxRunLivenessVerdict(run, now);
    if (verdict === 'stop') return;
    if (verdict === 'reschedule') {
      await ctx.scheduler.runAfter(
        SANDBOX_LIVENESS_CHECK_INTERVAL_MS,
        internal.analystSandbox.resumeOrFailStaleSandboxRun,
        { runId: args.runId },
      );
      return;
    }

    // verdict === 'dead'. Recovery does fallible work (fetch the post-mortem, relaunch a run). If
    // any of it throws, the failure MUST surface as a loud run event — never a swallowed throw that
    // kills this action and leaves the run hanging until the slow deadline reaper. That silent-chain
    // death is the original bug.
    try {
      await recoverDeadSandboxRun(ctx, run, backup);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Pi run liveness recovery threw', { runId: args.runId, error: message });
      await ctx
        .runMutation(internal.analystSandboxStore.emitSandboxRunNote, {
          runId: args.runId,
          label: 'Recovery failed',
          text: `The sandbox stopped responding and recovery failed: ${message}. Ask again to retry.`,
          now: Date.now(),
        })
        .catch((noteError) => {
          console.error('Pi run liveness recovery could not emit failure note', {
            runId: args.runId,
            error: noteError instanceof Error ? noteError.message : String(noteError),
          });
        });
    }
  },
});

async function recoverDeadSandboxRun(
  ctx: ActionCtx,
  run: Doc<'analystSandboxRuns'>,
  backup: { id: string; dir: string; localBucket?: boolean } | null,
) {
  // Capture the container post-mortem (exit code + stderr) so each interruption records its cause.
  let cause: string | undefined;
  try {
    ({ cause } = await captureSandboxPostMortem(ctx, run));
  } catch (error) {
    console.error('recoverDeadSandboxRun post-mortem failed', {
      runId: run._id,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const interruptedBase = 'The sandbox stopped responding (container exited).';
  const interrupted = await ctx.runMutation(
    internal.analystSandboxStore.markSandboxRunInterrupted,
    {
      runId: run._id,
      error: cause
        ? `${interruptedBase} Sandbox ${cause}. Recovering from the last checkpoint.`
        : `${interruptedBase} Recovering from the last checkpoint.`,
      now: Date.now(),
    },
  );

  // If the run reached a terminal state between the liveness query and now, markSandboxRunInterrupted
  // no-ops (returns the run unpatched). Don't launch a duplicate replacement for an already-finished run.
  if (interrupted?.status !== 'timed_out') {
    return;
  }

  const plan = planDeadRunRecovery(run);
  if (plan.action === 'give_up') {
    console.error('Pi run exhausted auto-resume attempts', {
      runId: run._id,
      attempts: plan.attempts,
    });
    await ctx.runMutation(internal.analystSandboxStore.emitSandboxRunNote, {
      runId: run._id,
      label: 'Stopped',
      text: `The sandbox kept stopping after ${SANDBOX_MAX_RESUME_ATTEMPTS} recovery attempts. Ask again to retry.`,
      now: Date.now(),
    });
    return;
  }

  const launched = await launchSandboxRun(ctx, {
    analystThreadId: run.analystThreadId,
    creatorUserId: run.creatorUserId,
    orgId: run.orgId,
    prompt: run.prompt,
    pageContextReferences: normalizeUnknownPageContextReferences(run.pageContextReferences),
    maxRuntimeMs: run.maxRuntimeMs,
    backup: backup ? { id: backup.id, dir: backup.dir, localBucket: backup.localBucket } : null,
    resumeAttempt: plan.resumeAttempt,
  });

  if (!launched.ok) {
    console.error('Pi run auto-resume failed to relaunch', {
      runId: run._id,
      resumedRunId: launched.runId,
      error: launched.error,
    });
    await ctx.runMutation(internal.analystSandboxStore.emitSandboxRunNote, {
      runId: run._id,
      label: 'Recovery failed',
      text: `The sandbox stopped responding and could not be relaunched: ${launched.error}. Ask again to retry.`,
      now: Date.now(),
    });
    return;
  }

  await ctx.runMutation(internal.analystSandboxStore.emitSandboxRunNote, {
    runId: launched.runId,
    label: 'Resumed',
    text: 'Resumed after interruption — picking up from the last checkpoint.',
    now: Date.now(),
  });
}
