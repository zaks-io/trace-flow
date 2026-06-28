import {
  Agent,
  abortStream,
  createTool,
  listStreams,
  listUIMessages,
  saveMessage,
  stepCountIs,
  syncStreams,
  vStreamArgs,
  type ToolCtx as AgentToolCtx,
} from '@convex-dev/agent';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import {
  dispatchToolCall,
  getTraceFlowToolDefinitions,
  LATEST_PROTOCOL_VERSION,
  type ToolCallParams,
  type ToolCallResult,
} from '@trace-flow/mcp-core';
import { paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';
import { z } from 'zod/v4';
import { requireEnabledUser } from './auth/users';
import { runUsageTotal, toPiRunRows, type SandboxRunEventInput } from './analystPiRows';
import { openRouterCost } from './analystUsage';
import {
  accumulateLedger,
  cumulativeDelta,
  maxCumulative,
  readThreadLedger,
  ZERO_CUMULATIVE,
  type CumulativeUsage,
} from './analystUsageLedger';
import { createMcpBackend } from './mcp/backend';
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
import type { DataModel, Doc, Id } from './_generated/dataModel';
import { rateLimiter } from './rateLimits';

export const ANALYST_DEFAULT_MODEL = 'z-ai/glm-5.2';
export const ANALYST_MAX_STEPS = 50;
export const TRACE_FLOW_ANALYST_METADATA_KEY = 'traceFlowAnalyst';

const ANALYST_MODEL = process.env.ANALYST_MODEL ?? ANALYST_DEFAULT_MODEL;
const TINYBIRD_BASE_URL = process.env.TINYBIRD_API_URL ?? 'https://api.us-west-2.aws.tinybird.co';
const MAX_PROMPT_CHARS = 20_000;
const MAX_PAGE_CONTEXT_REFS = 12;
const DEFAULT_PI_RUNTIME_MS = 60 * 60 * 1000;
const MAX_PI_RUNTIME_MS = 120 * 60 * 1000;
const MAX_SANDBOX_EVENT_BATCH = 50;
const MAX_SANDBOX_EVENT_MESSAGE_CHARS = 20_000;
const MAX_SANDBOX_RESULT_CHARS = 120_000;
const MAX_SANDBOX_LOG_EVENT_CHARS = 8_000;
const SANDBOX_CONTROL_FETCH_TIMEOUT_MS = 30_000;
export const SANDBOX_START_FETCH_TIMEOUT_MS = 180_000;
const SANDBOX_TIMEOUT_WATCHDOG_GRACE_MS = 30_000;
const SANDBOX_TIMEOUT_RESCHEDULE_PADDING_MS = 10_000;
// Liveness watchdog: the runner heartbeats every ~10s, so no event for this long
// while the run is active means the container died (deploy rollout, eviction, crash).
const SANDBOX_LIVENESS_CHECK_INTERVAL_MS = 30_000;
const SANDBOX_LIVENESS_STALE_MS = 30_000;
// A cold container can take longer than one interval to pull, boot, and emit its
// first heartbeat. Don't run the first liveness check until after that window so a
// legitimately-slow start isn't mistaken for a dead container.
const SANDBOX_LIVENESS_FIRST_CHECK_MS = 90_000;
// Auto-resume a dead container up to this many times before failing loudly, so a
// run that crashes on every start can't loop forever burning tokens and containers.
const SANDBOX_MAX_RESUME_ATTEMPTS = 2;
const ANALYST_STOP_POLL_MS = 1_000;
const ANALYST_STOP_REASON = 'user_stop';
const ANALYST_FINAL_RESPONSE_PROMPT = `You reached the Analyst step limit. Do not call more tools. Provide the best final answer you can from the information already gathered. If the answer is incomplete, say what is missing and what follow-up would resolve it.`;
const INTERNAL_SANDBOX_CONTINUATION_PREFIX =
  'A background Trace Flow data analysis run completed. Use this final composed response to answer the user';
const MAX_PI_FINAL_CONTEXT_CHARS = 24_000;

const sandboxTraceFlowToolDefinitions = getTraceFlowToolDefinitions('analyst');
const ACTIVE_SANDBOX_RUN_STATUSES = new Set(['queued', 'starting', 'running']);

export function getDirectAnalystTraceFlowToolDefinitions(): typeof sandboxTraceFlowToolDefinitions {
  return [];
}

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

const sandboxRunEventTypeValidator = v.union(
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

const sandboxRunEventInputValidator = v.object({
  type: sandboxRunEventTypeValidator,
  message: v.optional(v.string()),
  data: v.optional(v.any()),
  emittedAt: v.optional(v.number()),
});

const sandboxControlActionValidator = v.union(
  v.literal('status'),
  v.literal('tail'),
  v.literal('cancel'),
  v.literal('steer'),
  v.literal('follow_up'),
);

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

interface PageContextReference {
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

function clampPiRuntimeMs(maxRuntimeMinutes: number | undefined): number {
  if (!maxRuntimeMinutes || !Number.isFinite(maxRuntimeMinutes)) return DEFAULT_PI_RUNTIME_MS;
  return Math.min(Math.max(Math.round(maxRuntimeMinutes * 60 * 1000), 60_000), MAX_PI_RUNTIME_MS);
}

function truncateText(value: string | undefined, maxChars: number): string | undefined {
  if (!value) return value;
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated]`;
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function createSandboxRunToken(): Promise<{ token: string; hash: string }> {
  const token = randomHex(32);
  return { token, hash: await sha256Hex(token) };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildPiSandboxId(): string {
  return `pi-${randomHex(12)}`;
}

type EnabledOrgUser = Doc<'users'> & { orgId: Id<'organizations'> };

async function getEnabledActionUser(ctx: ActionCtx): Promise<EnabledOrgUser> {
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

async function getEnabledUserById(ctx: ActionCtx, userId: Id<'users'>): Promise<EnabledOrgUser> {
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

async function getOwnedThread(
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
  const actionCtx = ctx as unknown as ActionCtx;
  if (ctx.userId) {
    return getEnabledUserById(actionCtx, ctx.userId as Id<'users'>);
  }
  return getEnabledActionUser(actionCtx);
}

export function shouldExposeSandboxControlTool(prompt: string) {
  return /\b(cancel|status|tail|inspect|check|steer|follow[- ]?up|run id|pi run|sandbox run)\b/i.test(
    prompt,
  );
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

function buildAnalystTools(options: { allowSandboxControl?: boolean } = {}) {
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

function normalizeUnknownPageContextReferences(value: unknown): PageContextReference[] {
  if (!Array.isArray(value)) return [];
  const refs: PageContextReference[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const ref = item as Record<string, unknown>;
    if (
      ref.surface !== 'agents' ||
      typeof ref.objectId !== 'string' ||
      typeof ref.label !== 'string' ||
      typeof ref.route !== 'string'
    ) {
      continue;
    }
    refs.push({
      surface: 'agents',
      objectId: ref.objectId,
      label: ref.label,
      route: ref.route,
      filters:
        ref.filters && typeof ref.filters === 'object' && !Array.isArray(ref.filters)
          ? (ref.filters as Record<string, string | number | boolean | null>)
          : undefined,
    });
  }
  return normalizePageContextReferences(refs);
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

interface SandboxControlResponse {
  ok?: boolean;
  process?: {
    id?: string;
    status?: string;
    pid?: number;
    exitCode?: number;
    startTime?: string;
    endTime?: string;
  } | null;
  processes?: unknown[];
  logs?: {
    processId?: string;
    stdout?: { value?: string; truncated?: boolean };
    stderr?: { value?: string; truncated?: boolean };
  } | null;
  diagnostics?: string[];
}

interface SandboxRunTiming {
  _creationTime: number;
  status: string;
  startedAt?: number;
  maxRuntimeMs: number;
}

function sandboxRunDeadlineMs(run: SandboxRunTiming) {
  return (run.startedAt ?? run._creationTime) + run.maxRuntimeMs;
}

export function isSandboxRunTimeoutExpired(
  run: SandboxRunTiming,
  now: number,
  graceMs = SANDBOX_TIMEOUT_WATCHDOG_GRACE_MS,
) {
  return sandboxRunTimeoutRemainingMs(run, now, graceMs) === 0;
}

interface SandboxRunLiveness {
  status: string;
  startedAt?: number;
  lastEventAt?: number;
  _creationTime: number;
}

/**
 * Decide what the liveness watchdog should do for a run. 'reschedule' while it's
 * active and recently signalled, 'dead' once it's active but silent past the
 * staleness window (container exited), 'stop' once the run is terminal.
 */
export function sandboxRunLivenessVerdict(
  run: SandboxRunLiveness,
  now: number,
  staleMs = SANDBOX_LIVENESS_STALE_MS,
): 'reschedule' | 'dead' | 'stop' {
  if (!ACTIVE_SANDBOX_RUN_STATUSES.has(run.status)) return 'stop';
  const lastSignalAt = run.lastEventAt ?? run.startedAt ?? run._creationTime;
  return now - lastSignalAt < staleMs ? 'reschedule' : 'dead';
}

export function sandboxRunTimeoutRemainingMs(
  run: SandboxRunTiming,
  now: number,
  graceMs = SANDBOX_TIMEOUT_WATCHDOG_GRACE_MS,
) {
  if (!['queued', 'starting', 'running'].includes(run.status)) return null;
  return Math.max(0, sandboxRunDeadlineMs(run) + graceMs - now);
}

function sandboxLogMessage(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= MAX_SANDBOX_LOG_EVENT_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_SANDBOX_LOG_EVENT_CHARS)}\n...[truncated]`;
}

function buildSandboxControlEvents(
  run: Doc<'analystSandboxRuns'>,
  response: SandboxControlResponse,
) {
  const process = response.process ?? null;
  const processId = process?.id ?? run.processId ?? 'unknown';
  const status = process?.status ?? 'not_found';
  const exitCode =
    process && typeof process.exitCode === 'number' ? ` with exit code ${process.exitCode}` : '';
  const message =
    status === 'not_found'
      ? `Sandbox process ${processId} was not found. It may have exited before sending events.`
      : `Sandbox process ${processId} is ${status}${exitCode}.`;
  const events: {
    type: 'status' | 'stdout' | 'stderr';
    message?: string;
    data?: unknown;
    emittedAt?: number;
  }[] = [
    {
      type: status === 'not_found' ? 'stderr' : 'status',
      message,
      data: { process, processes: response.processes ?? [] },
    },
  ];

  const stdout = sandboxLogMessage(response.logs?.stdout?.value);
  if (stdout) {
    events.push({
      type: 'stdout',
      message: stdout,
      data: { processId, truncated: response.logs?.stdout?.truncated ?? false },
    });
  }

  const stderr = sandboxLogMessage(response.logs?.stderr?.value);
  if (stderr) {
    events.push({
      type: 'stderr',
      message: stderr,
      data: { processId, truncated: response.logs?.stderr?.truncated ?? false },
    });
  }

  const diagnostics = (response.diagnostics ?? [])
    .map(sandboxLogMessage)
    .filter((message): message is string => Boolean(message));
  for (const diagnostic of diagnostics) {
    events.push({
      type: 'stderr',
      message: diagnostic,
      data: { processId },
    });
  }

  return events;
}

function isActiveSandboxRunStatus(status: string) {
  return ACTIVE_SANDBOX_RUN_STATUSES.has(status);
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
  const { token, hash } = await createSandboxRunToken();
  const now = Date.now();
  const sandboxId = buildPiSandboxId();
  const resumed = Boolean(input.backup);
  const runId = await ctx.runMutation(internal.analyst.createSandboxRun, {
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
    internal.analyst.timeoutSandboxRunIfExpired,
    { runId },
  );
  await ctx.scheduler.runAfter(
    SANDBOX_LIVENESS_FIRST_CHECK_MS,
    internal.analyst.resumeOrFailStaleSandboxRun,
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

    await ctx.runMutation(internal.analyst.markSandboxRunStarted, {
      runId,
      userId: input.creatorUserId,
      processId: started.processId,
      now: Date.now(),
    });

    return { ok: true, runId, resumed, maxRuntimeMs: input.maxRuntimeMs };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.runMutation(internal.analyst.completeSandboxRunInternal, {
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
  let run = await ctx.runQuery(internal.analyst.getOwnedSandboxRunForAction, { runId, userId });
  if (!run) return { ok: false, error: 'Pi run not found.' };

  if (isSandboxRunTimeoutExpired(run, Date.now())) {
    await ctx.runMutation(internal.analyst.timeoutSandboxRunIfExpired, { runId });
    run = await ctx.runQuery(internal.analyst.getOwnedSandboxRunForAction, { runId, userId });
    if (!run) return { ok: false, error: 'Pi run not found.' };
  }

  if ((input.action === 'steer' || input.action === 'follow_up') && !input.message?.trim()) {
    return { ok: false, error: `${input.action} requires a message.` };
  }

  const events =
    input.action === 'tail'
      ? await ctx.runQuery(internal.analyst.getSandboxRunEventsForAction, {
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
    await ctx.runMutation(internal.analyst.recordSandboxControl, {
      runId,
      userId,
      action: input.action,
      message: input.message,
      now,
    });
  }

  const diagnosticEvents = buildSandboxControlEvents(run, sandboxResponse);
  if (diagnosticEvents.length > 0) {
    await ctx.runMutation(internal.analyst.appendSandboxRunEvents, {
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

async function cancelSandboxRunBestEffort(
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
  await ctx.runMutation(internal.analyst.recordSandboxControl, {
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
    await ctx.runMutation(internal.analyst.appendSandboxRunEvents, {
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
    await ctx.runMutation(internal.analyst.appendSandboxRunEvents, {
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

/**
 * One-line human cause for a dead run's terminal message, e.g.
 * "process pi-abc is killed with exit code 137" (137 = 128 + SIGKILL = OOM). Returns undefined
 * when there's genuinely nothing to say. Pure so it can be unit-tested without a sandbox.
 */
export function describeSandboxProcessCause(
  process: SandboxControlResponse['process'],
  fallbackProcessId?: string,
  fetchError?: string,
): string | undefined {
  if (process) {
    const id = process.id ?? fallbackProcessId ?? 'unknown';
    const status = process.status ?? 'unknown';
    const exit = typeof process.exitCode === 'number' ? ` with exit code ${process.exitCode}` : '';
    return `process ${id} is ${status}${exit}`;
  }
  if (fetchError) return `process diagnostics unavailable (${fetchError})`;
  return undefined;
}

function summarizeSandboxRun(run: Doc<'analystSandboxRuns'>) {
  if (isSandboxRunTimeoutExpired(run, Date.now())) {
    const deadline = sandboxRunDeadlineMs(run);
    return {
      _id: run._id,
      _creationTime: run._creationTime,
      analystThreadId: run.analystThreadId,
      status: 'timed_out',
      updatedAt: run.updatedAt,
      startedAt: run.startedAt,
      completedAt: run.completedAt ?? deadline,
      lastEventAt: run.lastEventAt,
      maxRuntimeMs: run.maxRuntimeMs,
      nextSeq: run.nextSeq,
      resultText: run.resultText,
      error:
        run.error ??
        'Run exceeded its configured max runtime and the sandbox did not send a completion callback.',
      needsStatusRefresh: run.status !== 'timed_out',
    };
  }

  return {
    _id: run._id,
    _creationTime: run._creationTime,
    analystThreadId: run.analystThreadId,
    status: run.status,
    updatedAt: run.updatedAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    lastEventAt: run.lastEventAt,
    maxRuntimeMs: run.maxRuntimeMs,
    nextSeq: run.nextSeq,
    resultText: run.resultText,
    error: run.error,
  };
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

export const cancelSandboxRun = action({
  args: { runId: v.id('analystSandboxRuns') },
  handler: async (ctx, args) => {
    const user = await getEnabledActionUser(ctx);
    let run = await ctx.runQuery(internal.analyst.getOwnedSandboxRunForAction, {
      runId: args.runId,
      userId: user._id,
    });
    if (!run) throw new Error('Pi run not found');

    if (isSandboxRunTimeoutExpired(run, Date.now())) {
      await ctx.runMutation(internal.analyst.timeoutSandboxRunIfExpired, { runId: args.runId });
      run = await ctx.runQuery(internal.analyst.getOwnedSandboxRunForAction, {
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
    const run = await ctx.runQuery(internal.analyst.getOwnedSandboxRunForAction, {
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

    await ctx.runMutation(internal.analyst.appendSandboxRunEvents, {
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

    const sandboxRuns = await ctx.runQuery(internal.analyst.getActiveSandboxRunsForAction, {
      threadId: thread._id,
      userId: user._id,
    });
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

export const refreshSandboxRunStatus = action({
  args: { runId: v.id('analystSandboxRuns') },
  handler: async (ctx, args) => {
    const user = await getEnabledActionUser(ctx);
    const run = await ctx.runQuery(internal.analyst.getOwnedSandboxRunForAction, {
      runId: args.runId,
      userId: user._id,
    });
    if (!run) throw new Error('Pi run not found');

    if (isSandboxRunTimeoutExpired(run, Date.now())) {
      await ctx.runMutation(internal.analyst.timeoutSandboxRunIfExpired, { runId: args.runId });
      const updated = await ctx.runQuery(internal.analyst.getOwnedSandboxRunForAction, {
        runId: args.runId,
        userId: user._id,
      });
      return updated ? summarizeSandboxRun(updated) : null;
    }

    return summarizeSandboxRun(run);
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

export const verifySandboxRunToken = action({
  args: {
    runId: v.id('analystSandboxRuns'),
    token: v.string(),
  },
  handler: async (ctx, args) => {
    const tokenHash = await sha256Hex(args.token);
    const run = await ctx.runQuery(internal.analyst.getVerifiedSandboxRunForAction, {
      runId: args.runId,
      tokenHash,
    });
    return { ok: Boolean(run), status: run?.status ?? null };
  },
});

export const receiveSandboxEvents = action({
  args: {
    runId: v.id('analystSandboxRuns'),
    token: v.string(),
    events: v.array(sandboxRunEventInputValidator),
  },
  handler: async (ctx, args) => {
    const tokenHash = await sha256Hex(args.token);
    await ctx.runMutation(internal.analyst.appendSandboxRunEvents, {
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
    await ctx.runMutation(internal.analyst.completeSandboxRunInternal, {
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
      await ctx.runMutation(internal.analyst.storeThreadSandboxBackup, {
        runId: args.runId,
        tokenHash,
        backup: args.backup,
        now: Date.now(),
      });
    }

    if (args.status === 'completed') {
      const scheduled = await ctx.runMutation(internal.analyst.markSandboxContinuationScheduled, {
        runId: args.runId,
        now: Date.now(),
      });
      if (scheduled) {
        await ctx.scheduler.runAfter(0, internal.analyst.continueAfterSandboxRun, {
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
    await ctx.runMutation(internal.analyst.storeThreadSandboxBackup, {
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
    const run = await ctx.runQuery(internal.analyst.getVerifiedSandboxRunForAction, {
      runId: args.runId,
      tokenHash,
    });
    if (!run) throw new Error('Pi run not found');
    if (!['queued', 'starting', 'running'].includes(run.status)) {
      throw new Error(`Pi run is ${run.status}`);
    }

    const user = await getEnabledUserById(ctx, run.creatorUserId);

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
      await ctx.runMutation(internal.analyst.appendSandboxRunEvents, {
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
    const run = await ctx.runQuery(internal.analyst.getSandboxRunForAction, { runId: args.runId });
    if (run?.status !== 'completed' || !run.resultText) return;

    await getEnabledUserById(ctx, run.creatorUserId);
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
    const thread = await getOwnedThread(ctx, args.userId, args.threadId);
    if (!thread) return [];
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
    events: v.array(sandboxRunEventInputValidator),
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
        internal.analyst.timeoutSandboxRunIfExpired,
        { runId: args.runId },
      );
      return false;
    }

    // Expired with no completion callback. A mutation can't fetch the container's exit code, so
    // hand off to an action that pulls the post-mortem (exit code + stderr) BEFORE stamping the
    // run terminal — so "timed out" carries why (e.g. exit 137 = OOM) instead of being a mystery.
    await ctx.scheduler.runAfter(0, internal.analyst.reapTimedOutSandboxRun, { runId: args.runId });
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
    const run = await ctx.runQuery(internal.analyst.getSandboxRunForReap, { runId: args.runId });
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
    await ctx.runMutation(internal.analyst.markSandboxRunTimedOut, {
      runId: args.runId,
      error,
      now: Date.now(),
    });
  },
});

export const getSandboxRunForReap = internalQuery({
  args: { runId: v.id('analystSandboxRuns') },
  handler: async (ctx, args) => ctx.db.get(args.runId),
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
    const context = await ctx.runQuery(internal.analyst.getSandboxRunLivenessContext, {
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
        internal.analyst.resumeOrFailStaleSandboxRun,
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
        .runMutation(internal.analyst.emitSandboxRunNote, {
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
  const attempt = run.resumeAttempt ?? 0;

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
  const interrupted = await ctx.runMutation(internal.analyst.markSandboxRunInterrupted, {
    runId: run._id,
    error: cause
      ? `${interruptedBase} Sandbox ${cause}. Recovering from the last checkpoint.`
      : `${interruptedBase} Recovering from the last checkpoint.`,
    now: Date.now(),
  });

  // If the run reached a terminal state between the liveness query and now, markSandboxRunInterrupted
  // no-ops (returns the run unpatched). Don't launch a duplicate replacement for an already-finished run.
  if (interrupted?.status !== 'timed_out') {
    return;
  }

  if (attempt >= SANDBOX_MAX_RESUME_ATTEMPTS) {
    console.error('Pi run exhausted auto-resume attempts', {
      runId: run._id,
      attempts: attempt,
    });
    await ctx.runMutation(internal.analyst.emitSandboxRunNote, {
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
    resumeAttempt: attempt + 1,
  });

  if (!launched.ok) {
    console.error('Pi run auto-resume failed to relaunch', {
      runId: run._id,
      resumedRunId: launched.runId,
      error: launched.error,
    });
    await ctx.runMutation(internal.analyst.emitSandboxRunNote, {
      runId: run._id,
      label: 'Recovery failed',
      text: `The sandbox stopped responding and could not be relaunched: ${launched.error}. Ask again to retry.`,
      now: Date.now(),
    });
    return;
  }

  await ctx.runMutation(internal.analyst.emitSandboxRunNote, {
    runId: launched.runId,
    label: 'Resumed',
    text: 'Resumed after interruption — picking up from the last checkpoint.',
    now: Date.now(),
  });
}

export const markSandboxContinuationScheduled = internalMutation({
  args: {
    runId: v.id('analystSandboxRuns'),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.continuationScheduledAt) return false;
    if (run.status !== 'completed' || !run.resultText) return false;
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
