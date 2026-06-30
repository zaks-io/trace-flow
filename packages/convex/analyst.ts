import {
  Agent,
  abortStream,
  listStreams,
  listUIMessages,
  saveMessage,
  stepCountIs,
  syncStreams,
  vStreamArgs,
} from '@convex-dev/agent';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';
import { requireEnabledUser } from './auth/users';
import { openRouterCost } from './analystUsage';
import { accumulateLedger, readThreadLedger } from './analystUsageLedger';
import {
  buildAnalystTools,
  cancelSandboxRunBestEffort,
  shouldExposeSandboxControlTool,
  truncateText,
} from './analystSandbox';
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  query,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from './_generated/server';
import { api, components, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { rateLimiter } from './rateLimits';

export const ANALYST_DEFAULT_MODEL = 'z-ai/glm-5.2';
export const ANALYST_MAX_STEPS = 50;
export const TRACE_FLOW_ANALYST_METADATA_KEY = 'traceFlowAnalyst';

export const ANALYST_MODEL = process.env.ANALYST_MODEL ?? ANALYST_DEFAULT_MODEL;
const MAX_PROMPT_CHARS = 20_000;
const MAX_PAGE_CONTEXT_REFS = 12;
const ANALYST_STOP_POLL_MS = 1_000;
const ANALYST_STOP_REASON = 'user_stop';
const ANALYST_FINAL_RESPONSE_PROMPT = `You reached the Analyst step limit. Do not call more tools. Provide the best final answer you can from the information already gathered. If the answer is incomplete, say what is missing and what follow-up would resolve it.`;
const INTERNAL_SANDBOX_CONTINUATION_PREFIX =
  'A background Trace Flow data analysis run completed. Use this final composed response to answer the user';
const MAX_PI_FINAL_CONTEXT_CHARS = 24_000;

const BASE_ANALYST_INSTRUCTIONS = `You are Trace Flow Analyst.

Answer questions about Trace Flow, LLM traces, usage, costs, and agent analytics.
Do not invent numbers or pretend page context is authoritative data.
The main Analyst must not ingest Trace Flow rows, trace bodies, usage tables, agent analytics tables, raw datasets, or raw tool results directly.
For any question that requires Trace Flow product data, numbers, traces, usage, costs, or agent analytics, call start_pi_agent_analysis. It runs the Trace Flow data analysis agent: an isolated sandbox whose only job is to answer Trace Flow data questions. It writes scripts, pages and saves raw payloads to disk, analyzes them with coding tools, validates summaries/aggregates locally, and returns a final composed response.
The data analysis agent is narrow by design: it only analyzes Trace Flow data and will decline anything else. Relay only the Trace Flow data question — restate it as a clear data-analysis task. Do not hand it work outside that scope (writing or editing application code, repository inspection, infrastructure, web access, sending messages); handle or decline such requests yourself instead of forwarding them, since it will refuse them.
start_pi_agent_analysis is the right tool for EVERY data question in this conversation, including follow-ups. The sandbox persists across the conversation: each run automatically resumes the previous one with its full session history and the data already downloaded to disk. So a follow-up does NOT start from scratch — it continues where the last run left off, reusing prior work. Phrase each prompt as the next question or refinement; do not re-explain context the agent already has, and do not ask it to re-download data it already fetched.
It returns immediately with a run id; the run continues asynchronously, streams in the UI, and will notify this conversation when it completes. After starting a run, wait for the async completion continuation before giving the final data answer. Do not call control_pi_agent_run just to wait. End the current turn with a short acknowledgement unless the user explicitly asked you to debug, steer, cancel, or add follow-up instructions to a specific existing run.
control_pi_agent_run steers a run that is still in flight (status, tail, cancel, steer, follow_up). Use follow_up/steer ONLY for a run that is currently running. For a new question after a run has completed, call start_pi_agent_analysis again — it resumes the same sandbox automatically; you do not need to, and must not, treat completion as losing context.
When a run completes, use its final composed response to answer the user. Do not request or infer raw datasets; raw data stays in sandbox artifacts.
Conversations are private, but every tool call still uses the current user's live permissions.
Direct Trace Flow data tools are intentionally not exposed to the main Analyst.`;

const pageContextReferenceValidator = v.object({
  surface: v.literal('agents'),
  objectId: v.string(),
  label: v.string(),
  route: v.string(),
  filters: v.optional(v.record(v.string(), v.union(v.string(), v.number(), v.boolean(), v.null()))),
});

const bootstrapAgent = new Agent(components.agent, {
  name: 'Trace Flow Analyst',
  languageModel: createAnalystLanguageModel('bootstrap', { requireKey: false }),
  instructions: BASE_ANALYST_INSTRUCTIONS,
});

export function buildAnalystThreadTitle(prompt: string): string {
  const title = prompt.replace(/\s+/g, ' ').trim();
  if (!title) return 'New analyst conversation';
  return title.length > 80 ? `${title.slice(0, 77)}...` : title;
}

export function buildOpenRouterExtraBody(analystThreadId: string): Record<string, unknown> {
  return {
    session_id: analystThreadId.slice(0, 256),
    usage: { include: true },
    cache_control: { type: 'ephemeral', ttl: '1h' },
  };
}

export function buildAnalystSystemPrompt(
  pageContextReferences: PageContextReference[] | undefined,
): string {
  const refs = normalizePageContextReferences(pageContextReferences);
  if (refs.length === 0) return BASE_ANALYST_INSTRUCTIONS;
  const hasAgentAnalyticsContext = refs.some(
    (ref) => ref.surface === 'agents' || ref.route.startsWith('/app/agents'),
  );
  const agentAnalyticsInstructions = hasAgentAnalyticsContext
    ? `\nThe /app/agents page is Agent Analytics. When the user's request refers to "my data", usage, costs, tokens, conversations, repos, models, sources, active days, or agent activity from this page, start the data analysis agent with instructions to use the sandbox-local REST/OpenAPI data operation query_agent_analytics from a script. For a simple 7-day overview or KPI summary, tell it to call query_agent_analytics directly with {"view":"summary","hours":168}; do not ask it to inspect OpenAPI or call describe_agent_analytics unless the request needs filter discovery, allowed values, or non-summary view parameters. Tell it to validate numbers with aggregates or script-computed checks and to keep raw rows on disk, not in model context. Do not default to generic trace tools unless the user explicitly asks about LLM traces.`
    : '';

  return `${BASE_ANALYST_INSTRUCTIONS}

Page context references for the user's next message:
${JSON.stringify(refs, null, 2)}
${agentAnalyticsInstructions}

Resolve these references through tools before making data claims.`;
}

function createAnalystLanguageModel(
  analystThreadId: string,
  options: { requireKey: boolean } = { requireKey: true },
) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey && options.requireKey) {
    throw new Error('OPENROUTER_API_KEY environment variable is not set');
  }

  const openrouter = createOpenRouter({
    apiKey: apiKey ?? 'missing-openrouter-key',
    appName: 'Trace Flow Analyst',
    appUrl: 'https://traceflow.dev',
  });

  return openrouter.chat(ANALYST_MODEL, {
    extraBody: buildOpenRouterExtraBody(analystThreadId),
  });
}

function createAnalystAgent(analystThreadId: string) {
  return new Agent(components.agent, {
    name: 'Trace Flow Analyst',
    languageModel: createAnalystLanguageModel(analystThreadId),
    instructions: BASE_ANALYST_INSTRUCTIONS,
    stopWhen: stepCountIs(ANALYST_MAX_STEPS),
    // Fold every LLM step's tokens + OpenRouter cost into the unified usage ledger.
    usageHandler: async (ctx, { threadId, usage, providerMetadata }) => {
      if (!threadId) return;
      const cacheReadTokens =
        usage.inputTokenDetails?.cacheReadTokens ?? usage.cachedInputTokens ?? 0;
      await ctx.runMutation(internal.analyst.recordAnalystUsageInternal, {
        agentThreadId: threadId,
        totalTokens: usage.totalTokens ?? 0,
        cacheReadTokens,
        cost: openRouterCost(providerMetadata),
        now: Date.now(),
      });
    },
  });
}

export function buildHiddenAnalystMessageMetadata() {
  return {
    providerMetadata: {
      [TRACE_FLOW_ANALYST_METADATA_KEY]: {
        hidden: true,
      },
    },
  };
}

export function isHiddenAnalystProviderMetadata(providerMetadata: unknown): boolean {
  if (!providerMetadata || typeof providerMetadata !== 'object') return false;
  const metadata = (providerMetadata as Record<string, unknown>)[TRACE_FLOW_ANALYST_METADATA_KEY];
  return Boolean(
    metadata &&
    typeof metadata === 'object' &&
    (metadata as Record<string, unknown>).hidden === true,
  );
}

export function isHiddenAnalystMessageLike(message: {
  role?: unknown;
  text?: unknown;
  message?: unknown;
  providerMetadata?: unknown;
  metadata?: unknown;
}) {
  const metadataProviderMetadata =
    message.metadata && typeof message.metadata === 'object'
      ? (message.metadata as { providerMetadata?: unknown }).providerMetadata
      : undefined;
  return (
    isHiddenAnalystProviderMetadata(message.providerMetadata) ||
    isHiddenAnalystProviderMetadata(metadataProviderMetadata) ||
    isInternalSandboxContinuationMessage(message)
  );
}

function isInternalSandboxContinuationMessage(message: {
  role?: unknown;
  text?: unknown;
  message?: unknown;
}) {
  const role =
    typeof message.role === 'string'
      ? message.role
      : message.message && typeof message.message === 'object'
        ? (message.message as { role?: unknown }).role
        : undefined;
  if (role !== 'user') return false;

  const text =
    typeof message.text === 'string'
      ? message.text
      : message.message && typeof message.message === 'object'
        ? readStringMessageContent((message.message as { content?: unknown }).content)
        : undefined;
  return Boolean(text?.trimStart().startsWith(INTERNAL_SANDBOX_CONTINUATION_PREFIX));
}

function readStringMessageContent(content: unknown): string | undefined {
  return typeof content === 'string' ? content : undefined;
}

export interface PageContextReference {
  surface: 'agents';
  objectId: string;
  label: string;
  route: string;
  filters?: Record<string, string | number | boolean | null>;
}

function normalizePageContextReferences(
  refs: PageContextReference[] | undefined,
): PageContextReference[] {
  return (refs ?? []).slice(0, MAX_PAGE_CONTEXT_REFS).map((ref) => ({
    surface: ref.surface,
    objectId: ref.objectId.slice(0, 160),
    label: ref.label.slice(0, 160),
    route: ref.route.slice(0, 240),
    filters: ref.filters,
  }));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type EnabledOrgUser = Doc<'users'> & { orgId: Id<'organizations'> };

export async function getEnabledActionUser(ctx: ActionCtx): Promise<EnabledOrgUser> {
  const user = await ctx.runQuery(api.auth.users.getCurrentUserQuery, {});
  if (!user) {
    throw new Error('User not found. Please log in again.');
  }
  if (!user.enabled) {
    throw new Error('User account is not enabled. Please contact support.');
  }
  if (!user.orgId) {
    throw new Error('User is not attached to an organization.');
  }
  return user as EnabledOrgUser;
}

export async function getEnabledUserById(
  ctx: ActionCtx,
  userId: Id<'users'>,
): Promise<EnabledOrgUser> {
  const user = await ctx.runQuery(internal.auth.users.getUserById, { id: userId });
  if (!user) {
    throw new Error('User not found. Please log in again.');
  }
  if (!user.enabled) {
    throw new Error('User account is not enabled. Please contact support.');
  }
  if (!user.orgId) {
    throw new Error('User is not attached to an organization.');
  }
  return user as EnabledOrgUser;
}

export async function getOwnedThread(
  ctx: QueryCtx | MutationCtx,
  userId: Id<'users'>,
  threadId: Id<'analystThreads'>,
) {
  const thread = await ctx.db.get(threadId);
  if (thread?.creatorUserId !== userId || thread?.status !== 'active') {
    return null;
  }
  return thread;
}

function watchAnalystStopRequest(
  ctx: ActionCtx,
  args: {
    threadId: Id<'analystThreads'>;
    userId: Id<'users'>;
    baselineAt: number;
    controller: AbortController;
  },
) {
  let closed = false;
  const done = (async () => {
    while (!closed && !args.controller.signal.aborted) {
      await sleep(ANALYST_STOP_POLL_MS);
      if (closed || args.controller.signal.aborted) return;

      const stopRequestedAt = await ctx
        .runQuery(internal.analyst.getThreadStopRequestedAtForAction, {
          threadId: args.threadId,
          userId: args.userId,
        })
        .catch(() => null);
      if (typeof stopRequestedAt === 'number' && stopRequestedAt >= args.baselineAt) {
        args.controller.abort(ANALYST_STOP_REASON);
        return;
      }
    }
  })();

  return {
    signal: args.controller.signal,
    close: async () => {
      closed = true;
      await done.catch(() => undefined);
    },
  };
}

async function shouldStopAnalystRun(
  ctx: ActionCtx,
  args: {
    threadId: Id<'analystThreads'>;
    userId: Id<'users'>;
    baselineAt: number;
  },
) {
  const stopRequestedAt = await ctx.runQuery(internal.analyst.getThreadStopRequestedAtForAction, {
    threadId: args.threadId,
    userId: args.userId,
  });
  return typeof stopRequestedAt === 'number' && stopRequestedAt >= args.baselineAt;
}

export function buildPiCompletionPrompt(run: { _id: string; prompt: string; resultText?: string }) {
  return [
    `${INTERNAL_SANDBOX_CONTINUATION_PREFIX}.`,
    '',
    `Run ID: ${run._id}`,
    '',
    'Original user request:',
    run.prompt,
    '',
    'Data analysis agent final composed response:',
    truncateText(run.resultText, MAX_PI_FINAL_CONTEXT_CHARS) ?? '',
    '',
    'Use this final composed response to answer the user. Do not request, reconstruct, or infer raw datasets; raw data stayed in sandbox artifacts.',
  ].join('\n');
}

export const listThreads = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireEnabledUser(ctx);
    const threads = await ctx.db
      .query('analystThreads')
      .withIndex('by_creator_status_updated', (q) =>
        q.eq('creatorUserId', user._id).eq('status', 'active'),
      )
      .collect();

    return threads
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 50)
      .map((thread) => ({
        _id: thread._id,
        _creationTime: thread._creationTime,
        title: thread.title,
        status: thread.status,
        updatedAt: thread.updatedAt,
        lastMessageAt: thread.lastMessageAt,
      }));
  },
});

export const listMessages = query({
  args: {
    threadId: v.id('analystThreads'),
    paginationOpts: paginationOptsValidator,
    streamArgs: vStreamArgs,
  },
  handler: async (ctx, args) => {
    const user = await requireEnabledUser(ctx);
    const thread = await getOwnedThread(ctx, user._id, args.threadId);
    if (!thread) {
      throw new Error('Conversation not found');
    }

    const agentArgs = {
      threadId: thread.agentThreadId,
      paginationOpts: args.paginationOpts,
      streamArgs: args.streamArgs,
    };
    const paginated = await listUIMessages(ctx, components.agent, agentArgs);
    const streams = await syncStreams(ctx, components.agent, agentArgs);
    return {
      ...paginated,
      page: paginated.page.filter((message) => !isHiddenAnalystMessageLike(message)),
      streams,
    };
  },
});

/**
 * Admin-only conversation cost summary. Returns `null` for non-admins (the client
 * gates on `useIsAdmin`, so this is a debug/observability surface) and the totals
 * otherwise: the conversation Analyst's own LLM usage vs. the Pi coding agent's,
 * so an admin can see where the tokens and dollars went.
 */
export const conversationUsageSummary = query({
  args: { threadId: v.id('analystThreads') },
  handler: async (ctx, args) => {
    const user = await requireEnabledUser(ctx);
    const thread = await getOwnedThread(ctx, user._id, args.threadId);
    if (!thread) throw new Error('Conversation not found');
    if (!user.isAdmin) return null;

    return readThreadLedger(ctx, args.threadId);
  },
});

export const stopRun = action({
  args: { threadId: v.id('analystThreads') },
  handler: async (ctx, args) => {
    const user = await getEnabledActionUser(ctx);
    const thread = await ctx.runQuery(internal.analyst.getOwnedThreadForAction, {
      threadId: args.threadId,
      userId: user._id,
    });
    if (!thread) throw new Error('Conversation not found');

    const now = Date.now();
    await ctx.runMutation(internal.analyst.requestThreadStop, {
      threadId: thread._id,
      userId: user._id,
      now,
    });

    const streamErrors: string[] = [];
    let abortedStreams = 0;
    const streams = await listStreams(ctx, components.agent, {
      threadId: thread.agentThreadId,
      includeStatuses: ['streaming'],
    });
    for (const stream of streams) {
      try {
        const aborted = await abortStream(ctx, components.agent, {
          streamId: stream.streamId,
          reason: ANALYST_STOP_REASON,
        });
        if (aborted) abortedStreams += 1;
      } catch (err) {
        streamErrors.push(err instanceof Error ? err.message : String(err));
      }
    }

    const sandboxRuns = await ctx.runQuery(
      internal.analystSandboxStore.getActiveSandboxRunsForAction,
      {
        threadId: thread._id,
        userId: user._id,
      },
    );
    const sandboxResults = [];
    for (const run of sandboxRuns) {
      sandboxResults.push(await cancelSandboxRunBestEffort(ctx, user._id, run));
    }

    return {
      ok: streamErrors.length === 0 && sandboxResults.every((result) => result.ok),
      abortedStreams,
      streamErrors,
      cancelledSandboxRuns: sandboxResults.length,
      sandboxResults,
    };
  },
});

export const sendMessage = action({
  args: {
    threadId: v.optional(v.id('analystThreads')),
    prompt: v.string(),
    pageContextReferences: v.optional(v.array(pageContextReferenceValidator)),
  },
  handler: async (ctx, args): Promise<{ threadId: Id<'analystThreads'> }> => {
    const user = await getEnabledActionUser(ctx);
    await rateLimiter.limit(ctx, 'analystSendMessage', { key: user._id, throws: true });

    const prompt = args.prompt.trim();
    if (!prompt) throw new Error('Message is required');
    if (prompt.length > MAX_PROMPT_CHARS) throw new Error('Message is too long');

    let analystThread: Doc<'analystThreads'>;
    if (args.threadId) {
      const existing = await ctx.runQuery(internal.analyst.getOwnedThreadForAction, {
        threadId: args.threadId,
        userId: user._id,
      });
      if (!existing) throw new Error('Conversation not found');
      analystThread = existing;
    } else {
      const { threadId: agentThreadId } = await bootstrapAgent.createThread(ctx, {
        userId: user._id,
        title: buildAnalystThreadTitle(prompt),
      });
      const threadId = await ctx.runMutation(internal.analyst.insertThread, {
        creatorUserId: user._id,
        orgId: user.orgId,
        agentThreadId,
        title: buildAnalystThreadTitle(prompt),
        now: Date.now(),
      });
      const inserted = await ctx.runQuery(internal.analyst.getOwnedThreadForAction, {
        threadId,
        userId: user._id,
      });
      if (!inserted) throw new Error('Failed to create conversation');
      analystThread = inserted;
    }

    const now = Date.now();
    await ctx.runMutation(internal.analyst.touchThread, {
      threadId: analystThread._id,
      userId: user._id,
      now,
    });

    await ctx.scheduler.runAfter(0, internal.analyst.streamMessage, {
      threadId: analystThread._id,
      userId: user._id,
      prompt,
      pageContextReferences: normalizePageContextReferences(args.pageContextReferences),
      stopBaselineAt: now,
    });

    return { threadId: analystThread._id };
  },
});

async function saveHiddenAnalystPrompt(
  ctx: ActionCtx,
  args: {
    threadId: string;
    userId: Id<'users'>;
    prompt: string;
  },
) {
  const { messageId } = await saveMessage(ctx, components.agent, {
    threadId: args.threadId,
    userId: String(args.userId),
    message: { role: 'user', content: args.prompt },
    metadata: buildHiddenAnalystMessageMetadata(),
  });
  return messageId;
}

async function streamAnalystText(
  ctx: ActionCtx,
  args: {
    analystThread: Doc<'analystThreads'>;
    userId: Id<'users'>;
    prompt: string;
    pageContextReferences?: PageContextReference[];
    hiddenPrompt?: boolean;
    stopBaselineAt?: number;
  },
) {
  const stopBaselineAt = args.stopBaselineAt ?? Date.now();
  if (
    await shouldStopAnalystRun(ctx, {
      threadId: args.analystThread._id,
      userId: args.userId,
      baselineAt: stopBaselineAt,
    })
  ) {
    return;
  }

  const agent = createAnalystAgent(args.analystThread._id);
  const abortController = new AbortController();
  const stopWatcher = watchAnalystStopRequest(ctx, {
    threadId: args.analystThread._id,
    userId: args.userId,
    baselineAt: stopBaselineAt,
    controller: abortController,
  });
  const promptMessageId = args.hiddenPrompt
    ? await saveHiddenAnalystPrompt(ctx, {
        threadId: args.analystThread.agentThreadId,
        userId: args.userId,
        prompt: args.prompt,
      })
    : undefined;

  try {
    const result = await agent.streamText(
      ctx,
      { threadId: args.analystThread.agentThreadId, userId: String(args.userId) },
      {
        prompt: args.prompt,
        promptMessageId,
        system: buildAnalystSystemPrompt(args.pageContextReferences),
        tools: buildAnalystTools({
          allowSandboxControl: shouldExposeSandboxControlTool(args.prompt),
        }),
        stopWhen: stepCountIs(ANALYST_MAX_STEPS - 1),
        abortSignal: stopWatcher.signal,
      },
      analystStreamOptions(),
    );

    if (stopWatcher.signal.aborted) return;

    if (await shouldRunFinalAnalystSynthesis(result)) {
      if (stopWatcher.signal.aborted) return;
      await agent.streamText(
        ctx,
        { threadId: args.analystThread.agentThreadId, userId: String(args.userId) },
        {
          messages: [{ role: 'assistant', content: ANALYST_FINAL_RESPONSE_PROMPT }],
          promptMessageId: result.promptMessageId,
          system: buildAnalystSystemPrompt(args.pageContextReferences),
          tools: {},
          stopWhen: stepCountIs(1),
          abortSignal: stopWatcher.signal,
        },
        analystStreamOptions(),
      );
    }
  } catch (err) {
    if (stopWatcher.signal.aborted) return;
    throw err;
  } finally {
    await stopWatcher.close();
  }
}

function analystStreamOptions() {
  return {
    saveStreamDeltas: {
      chunking: 'word' as const,
      throttleMs: 100,
    },
  };
}

async function shouldRunFinalAnalystSynthesis(result: {
  steps: PromiseLike<unknown[] | undefined>;
  savedMessages?: unknown[];
}) {
  const steps = await Promise.resolve(result.steps).catch(() => undefined);
  if (!steps || steps.length < ANALYST_MAX_STEPS - 1) return false;
  return !hasPendingAnalystToolWork(result.savedMessages ?? []);
}

function hasPendingAnalystToolWork(savedMessages: unknown[]) {
  const toolCalls = new Set<string>();
  const toolResults = new Set<string>();

  for (const message of savedMessages) {
    for (const part of messageContentParts(message)) {
      const record = part as Record<string, unknown>;
      if (record.type === 'tool-approval-request') return true;
      if (record.type === 'tool-call') {
        const toolCallId = typeof record.toolCallId === 'string' ? record.toolCallId : undefined;
        if (toolCallId) toolCalls.add(toolCallId);
      }
      if (record.type === 'tool-result') {
        const toolCallId = typeof record.toolCallId === 'string' ? record.toolCallId : undefined;
        if (toolCallId) toolResults.add(toolCallId);
        if (isPendingAsyncPiOutput(record.output)) return true;
      }
    }
  }

  for (const toolCallId of toolCalls) {
    if (!toolResults.has(toolCallId)) return true;
  }
  return false;
}

function messageContentParts(message: unknown) {
  if (!message || typeof message !== 'object') return [];
  const content = (message as { message?: { content?: unknown } }).message?.content;
  return Array.isArray(content) ? content.filter((part) => part && typeof part === 'object') : [];
}

function isPendingAsyncPiOutput(output: unknown): boolean {
  const value = unwrapToolOutputValue(output);
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    record.type === 'async_pi_agent_run' &&
    record.async === true &&
    (record.status === 'queued' || record.status === 'starting' || record.status === 'running')
  );
}

function unwrapToolOutputValue(output: unknown): unknown {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return output;
  const record = output as Record<string, unknown>;
  if (record.type === 'json' && 'value' in record) return unwrapToolOutputValue(record.value);
  if (Object.keys(record).length === 1 && 'output' in record) {
    return unwrapToolOutputValue(record.output);
  }
  return output;
}

export const streamMessage = internalAction({
  args: {
    threadId: v.id('analystThreads'),
    userId: v.id('users'),
    prompt: v.string(),
    pageContextReferences: v.optional(v.array(pageContextReferenceValidator)),
    hiddenPrompt: v.optional(v.boolean()),
    stopBaselineAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const user = await getEnabledUserById(ctx, args.userId);
    const analystThread = await ctx.runQuery(internal.analyst.getOwnedThreadForAction, {
      threadId: args.threadId,
      userId: user._id,
    });
    if (!analystThread) throw new Error('Conversation not found');

    await streamAnalystText(ctx, {
      analystThread,
      userId: user._id,
      prompt: args.prompt,
      pageContextReferences: args.pageContextReferences,
      hiddenPrompt: args.hiddenPrompt,
      stopBaselineAt: args.stopBaselineAt,
    });

    await ctx.runMutation(internal.analyst.touchThread, {
      threadId: analystThread._id,
      userId: user._id,
      now: Date.now(),
    });
  },
});

export const getOwnedThreadForAction = internalQuery({
  args: {
    threadId: v.id('analystThreads'),
    userId: v.id('users'),
  },
  handler: async (ctx, args) => getOwnedThread(ctx, args.userId, args.threadId),
});

export const getThreadStopRequestedAtForAction = internalQuery({
  args: {
    threadId: v.id('analystThreads'),
    userId: v.id('users'),
  },
  handler: async (ctx, args) => {
    const thread = await getOwnedThread(ctx, args.userId, args.threadId);
    return thread?.stopRequestedAt ?? null;
  },
});

export const getThreadByAgentThreadIdForAction = internalQuery({
  args: {
    agentThreadId: v.string(),
    userId: v.id('users'),
  },
  handler: async (ctx, args) => {
    const thread = await ctx.db
      .query('analystThreads')
      .withIndex('by_agent_thread_id', (q) => q.eq('agentThreadId', args.agentThreadId))
      .first();
    if (thread?.creatorUserId !== args.userId || thread.status !== 'active') return null;
    return thread;
  },
});

export const insertThread = internalMutation({
  args: {
    creatorUserId: v.id('users'),
    orgId: v.id('organizations'),
    agentThreadId: v.string(),
    title: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args): Promise<Id<'analystThreads'>> => {
    return ctx.db.insert('analystThreads', {
      creatorUserId: args.creatorUserId,
      orgId: args.orgId,
      agentThreadId: args.agentThreadId,
      title: args.title,
      status: 'active',
      updatedAt: args.now,
      lastMessageAt: args.now,
    });
  },
});

/**
 * Fold one Analyst LLM step's usage into the (thread, 'analyst') ledger. Called from the
 * agent's usageHandler, which only knows the agent-component thread id — we resolve it back
 * to our analystThreads row to attach org/creator. A step we can't attribute is dropped.
 */
export const recordAnalystUsageInternal = internalMutation({
  args: {
    agentThreadId: v.string(),
    totalTokens: v.number(),
    cacheReadTokens: v.number(),
    cost: v.optional(v.number()),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const thread = await ctx.db
      .query('analystThreads')
      .withIndex('by_agent_thread_id', (q) => q.eq('agentThreadId', args.agentThreadId))
      .first();
    if (!thread) return;

    await accumulateLedger(ctx, {
      analystThreadId: thread._id,
      orgId: thread.orgId,
      creatorUserId: thread.creatorUserId,
      agent: 'analyst',
      delta: {
        totalTokens: Math.max(0, args.totalTokens),
        totalCost: Math.max(0, args.cost ?? 0),
        cacheReadTokens: Math.max(0, args.cacheReadTokens),
        requests: 1,
        hasCost: args.cost !== undefined,
      },
      now: args.now,
    });
  },
});

export const requestThreadStop = internalMutation({
  args: {
    threadId: v.id('analystThreads'),
    userId: v.id('users'),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const thread = await getOwnedThread(ctx, args.userId, args.threadId);
    if (!thread) throw new Error('Conversation not found');
    await ctx.db.patch(args.threadId, {
      stopRequestedAt: args.now,
      updatedAt: args.now,
    });
  },
});

export const touchThread = internalMutation({
  args: {
    threadId: v.id('analystThreads'),
    userId: v.id('users'),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const thread = await getOwnedThread(ctx, args.userId, args.threadId);
    if (!thread) throw new Error('Conversation not found');
    await ctx.db.patch(args.threadId, {
      updatedAt: args.now,
      lastMessageAt: args.now,
    });
  },
});
