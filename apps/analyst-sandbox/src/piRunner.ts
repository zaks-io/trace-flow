import { PI_CONTEXT_GUARD_SOURCE } from './piRunnerContextGuard';
import { PI_SYSTEM_PROMPT_SOURCE } from './piRunnerPrompt';

export {
  buildPiModelsJson,
  buildPiRunRequest,
  buildPiWorkspaceManifest,
  getPiRunnerPaths,
  pricingToPiCost,
  type PiModelCost,
} from './piRunnerConfig';

export function buildPiRunnerScript() {
  return String.raw`import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const runId = requiredEnv('TRACEFLOW_RUN_ID');
const runToken = requiredEnv('TRACEFLOW_RUN_TOKEN');
const sandboxId = requiredEnv('TRACEFLOW_SANDBOX_ID');
const workerBaseUrl = requiredEnv('TRACEFLOW_WORKER_BASE_URL');
const requestPath = requiredEnv('TRACEFLOW_REQUEST_PATH');
const controlPath = requiredEnv('TRACEFLOW_CONTROL_PATH');
const agentDir = process.env.PI_CODING_AGENT_DIR ?? '/workspace/.pi/agent';
const runDir = path.join('/workspace/runs', runId);
const dataApiDescriptorPath = path.join(runDir, 'traceflow-data-api.json');
const contextGuardExtensionPath = path.join(runDir, 'traceflow-context-guard.ts');
const request = JSON.parse(await fs.readFile(requestPath, 'utf8'));
let resultText = '';
let completed = false;
let timedOut = false;
let session;
let dataApiServer;
let dataApiBaseUrl = '';
let controlOffset = 0;
const eventBuffer = [];
let flushQueue = Promise.resolve();
let consecutiveFlushFailures = 0;
let timeoutTimer;
let controlTimer;
let flushTimer;
let idleTimer;
let heartbeatTimer;
let lastActivityAt = Date.now();
let piEventCount = 0;
let latestPhase = 'starting';
let latestToolName;
let latestUsageSignature = '';
// The command/args live on tool_execution_start; the result on _end. We stash the
// start's command preview by toolCallId so the persisted end row carries both.
const toolCommandsByCallId = new Map();
let latestToolResultText = '';
let latestToolResultName = '';
const IDLE_COMPLETION_MS = Math.min(60000, Math.max(20000, Math.round(request.maxRuntimeMs / 12)));
const MIN_IDLE_COMPLETION_TEXT_CHARS = 80;
const HEARTBEAT_MS = 10000;
const EVENT_FLUSH_MAX_ATTEMPTS = 4;
const EVENT_FLUSH_RETRY_BASE_MS = 250;
const EVENT_BUFFER_RETAIN = 100;
const EVENT_BUFFER_MAX = 500;
const STDERR_TAIL_MAX_CHARS = 8000;
const PROVIDER_REQUEST_TIMEOUT_MS = Math.min(request.maxRuntimeMs, 2 * 60 * 1000);
const PROVIDER_IDLE_TIMEOUT_MS = 30000;
// These are catastrophe backstops, NOT a working budget. Normal runs must never hit them:
// the prompt and the Python client steer the agent to fetch+aggregate in code and return
// small summaries, so a legitimate result stays far below these. They only fire when
// something has gone badly wrong (a full-table dump, a runaway loop) and would otherwise
// blow the 128K context window. Sized generously so real analysis is never crippled.
const MAX_TOOL_RESULT_CONTEXT_CHARS = 60000;
const MAX_MESSAGE_CONTEXT_CHARS = 80000;
const MAX_PROVIDER_PAYLOAD_CHARS = 420000;

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(name + ' is required');
  return value;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Forward the runner's OWN diagnostic output to Convex so a crash leaves a trail, not just a
// line in an unforwarded container log. We tee console.error (where death traces, flush
// failures, and Node warnings land) into a 'stderr' event. Tool command output is already
// captured via Pi tool_result events, so we only mirror the runner process's own stderr here.
const baseConsoleError = console.error.bind(console);
let teeingStderr = false;
console.error = (...args) => {
  baseConsoleError(...args);
  if (teeingStderr) return; // guard against recursion if emit() ever logs
  teeingStderr = true;
  try {
    const text = args
      .map((a) => (typeof a === 'string' ? a : a instanceof Error ? (a.stack ?? a.message) : safeStringify(a)))
      .join(' ')
      .slice(0, STDERR_TAIL_MAX_CHARS);
    eventBuffer.push({ emittedAt: Date.now(), type: 'stderr', message: text });
  } finally {
    teeingStderr = false;
  }
};

function safeStringify(value, maxChars = 6000) {
  try {
    const text = JSON.stringify(value);
    return text.length <= maxChars ? text : text.slice(0, maxChars) + '\n...[truncated]';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function truncateText(value, maxChars = 6000) {
  const text = typeof value === 'string' ? value : '';
  return text.length <= maxChars ? text : text.slice(0, maxChars) + '\n...[truncated]';
}

${PI_CONTEXT_GUARD_SOURCE}

const TOOL_COMMAND_KEYS = ['command', 'cmd', 'path', 'file', 'pattern', 'query', 'view'];

// The native event carries arguments as a real object (no parsing). Pull the
// single most descriptive field so the work log can show what the tool did.
function toolCommandPreview(args) {
  let record = args;
  if (typeof record === 'string') {
    try {
      record = JSON.parse(record);
    } catch {
      return truncateText(args.trim(), 200);
    }
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) return '';
  for (const key of TOOL_COMMAND_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return truncateText(value.trim(), 200);
  }
  return '';
}

// The work log is built ONLY from the clean, typed rows we persist here. We pull
// the meaningful fields straight off the native event object (which is fully
// structured — no string-inside-a-string, no parsing) and never persist the raw
// event dump. Downstream (Convex query + client) just reads these fields.
//
// Persisted shapes (all under data, discriminated by data.kind):
//   { kind: 'tool', toolName, command, output, isError }  - one completed tool step
//   { kind: 'text', text }                                - one finished assistant turn
function describeSessionEvent(event) {
  const eventType = typeof event?.type === 'string' ? event.type : 'session_event';

  latestPhase = eventType;
  if (typeof event?.toolName === 'string') latestToolName = event.toolName;

  const callId = typeof event?.toolCallId === 'string' ? event.toolCallId : undefined;

  // The command/args are on the START event. Stash a preview so the completed END
  // row can show *what* the tool did, then drop the start (no row of its own).
  if (eventType === 'tool_execution_start') {
    if (callId) toolCommandsByCallId.set(callId, toolCommandPreview(event?.args ?? event?.arguments));
    return null;
  }

  // A completed tool step is the unit of work — one finished row carrying the
  // command (from the matching start) and its result.
  if (eventType === 'tool_execution_end') {
    const isError = event?.isError === true;
    const command = callId ? (toolCommandsByCallId.get(callId) ?? '') : '';
    if (callId) toolCommandsByCallId.delete(callId);
    return {
      type: isError ? 'error' : 'message',
      message: 'tool',
      data: {
        kind: 'tool',
        toolName: typeof event?.toolName === 'string' ? event.toolName : 'tool',
        command: command || toolCommandPreview(event?.args ?? event?.arguments),
        output: truncateText(messageContentText(event?.result), 800),
        isError,
      },
    };
  }

  // The SDK retries a failed provider call silently; surface it so a retry-then-give-up does
  // not look like a hang. A retry firing at all means the provider already failed once.
  if (eventType === 'auto_retry_start') {
    return {
      type: 'status',
      message: 'Provider call failed; auto-retrying',
      data: {
        phase: eventType,
        attempt: event?.attempt,
        maxAttempts: event?.maxAttempts,
        delayMs: event?.delayMs,
        errorMessage: typeof event?.errorMessage === 'string' ? event.errorMessage : undefined,
      },
    };
  }
  if (eventType === 'auto_retry_end') {
    const success = event?.success === true;
    const finalError = typeof event?.finalError === 'string' ? event.finalError : undefined;
    return {
      type: success ? 'status' : 'error',
      message: success ? 'Auto-retry succeeded' : 'Auto-retry exhausted: ' + (finalError ?? 'unknown error'),
      data: { phase: eventType, success, attempt: event?.attempt, finalError },
    };
  }

  // A finished assistant turn carries the agent's narration as clean markdown.
  if (eventType === 'turn_end') {
    const text = messageContentText(event?.message, true).trim();
    if (!text) return null;
    return {
      type: 'message',
      message: 'turn',
      data: { kind: 'text', text },
    };
  }

  // Everything else — token-level deltas (message_update), tool starts/updates,
  // and lifecycle bookkeeping (message_start/end, agent_start/end, turn_start) — is
  // either redundant or noise and is never persisted. Streaming text is accumulated
  // into resultText separately (see appendResultText).
  return null;
}

function appendResultText(text) {
  const next = typeof text === 'string' ? text : '';
  if (!next) return;
  resultText += next;
}

function messageContentText(message, includeThinking = false) {
  if (!message || typeof message !== 'object' || !Array.isArray(message.content)) return '';
  return message.content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      if (part.type === 'text' && typeof part.text === 'string') return part.text;
      if (includeThinking && part.type === 'thinking' && typeof part.thinking === 'string') {
        return part.thinking;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n\n');
}

function resultTextFromEvent(event) {
  if (event?.type !== 'turn_end') return '';
  return messageContentText(event.message);
}

function completedToolResultTextFromEvent(event) {
  if (event?.type !== 'tool_execution_end' || event?.isError) return '';
  return messageContentText(event.result);
}

function normalizeTraceflowArguments(value) {
  if (value === undefined || value === null) return {};
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return {};
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Trace Flow data arguments must be a JSON object');
    }
    return parsed;
  }
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  throw new Error('Trace Flow data arguments must be an object');
}

function readToolDefinitions() {
  return Array.isArray(request.toolDefinitions)
    ? request.toolDefinitions.filter((definition) => definition && typeof definition === 'object')
    : [];
}

function readToolName(definition) {
  return typeof definition?.name === 'string' ? definition.name : undefined;
}

function readToolInputSchema(definition) {
  const schema = definition?.inputSchema;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { type: 'object', additionalProperties: true };
  }
  return schema;
}

function findToolDefinition(toolName) {
  return readToolDefinitions().find((definition) => readToolName(definition) === toolName);
}

function buildTraceflowOpenApiDocument() {
  const paths = {
    '/health': {
      get: {
        operationId: 'health',
        summary: 'Check the sandbox-local Trace Flow Data API.',
        responses: {
          '200': {
            description: 'API status.',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
    },
    '/tools': {
      get: {
        operationId: 'list_traceflow_tools',
        summary: 'List approved Trace Flow tools for this run.',
        responses: {
          '200': {
            description: 'Approved tool definitions.',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
    },
    '/tools/{toolName}': {
      post: {
        operationId: 'call_traceflow_tool',
        summary: 'Call an approved Trace Flow tool by name with raw JSON arguments.',
        description:
          'Returns the decoded JSON result directly. Use limit and cursor arguments when the tool schema exposes them.',
        parameters: [
          {
            name: 'toolName',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: { type: 'object', additionalProperties: true },
            },
          },
        },
        responses: {
          '200': {
            description: 'Decoded Trace Flow tool result.',
            content: { 'application/json': { schema: {} } },
          },
        },
      },
    },
  };

  for (const definition of readToolDefinitions()) {
    const name = readToolName(definition);
    if (!name) continue;
    paths['/tools/' + name] = {
      post: {
        operationId: name,
        summary: definition.description ?? 'Call ' + name,
        description:
          (definition.description ?? 'Call ' + name) +
          ' The request body is the tool JSON arguments. The response is the decoded JSON result. If the schema has limit/cursor fields, page through results until the result has no next cursor.',
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: readToolInputSchema(definition),
            },
          },
        },
        responses: {
          '200': {
            description: 'Decoded Trace Flow tool result.',
            content: { 'application/json': { schema: {} } },
          },
        },
      },
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Trace Flow Sandbox Data API',
      version: '1.0.0',
      description:
        'Sandbox-local unauthenticated API for this Pi run. The server owns the run capability token; Convex validates current permissions on every data call.',
    },
    servers: [{ url: dataApiBaseUrl }],
    paths,
  };
}

function unwrapTraceflowToolResult(result) {
  if (result?.isError) {
    const message = result.content?.map((part) => part?.text).filter(Boolean).join('\n') || 'Trace Flow tool failed';
    throw new Error(message);
  }
  const textParts = Array.isArray(result?.content)
    ? result.content.filter((part) => part?.type === 'text' && typeof part.text === 'string')
    : [];
  if (textParts.length === 1) {
    const text = textParts[0].text;
    try {
      return JSON.parse(text);
    } catch {
      return { text };
    }
  }
  return result;
}

async function readRequestJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2_000_000) throw new Error('Request body is too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  const parsed = JSON.parse(text);
  return normalizeTraceflowArguments(parsed);
}

function sendJson(res, status, value) {
  const text = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(text);
}

async function handleTraceflowDataApiRequest(req, res) {
  const url = new URL(req.url ?? '/', dataApiBaseUrl || 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, { ok: true, runId, openapiUrl: dataApiBaseUrl + '/openapi.json' });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/openapi.json') {
    sendJson(res, 200, buildTraceflowOpenApiDocument());
    return;
  }
  if (req.method === 'GET' && url.pathname === '/tools') {
    sendJson(res, 200, {
      openapiUrl: dataApiBaseUrl + '/openapi.json',
      tools: readToolDefinitions(),
    });
    return;
  }
  if (req.method === 'POST' && url.pathname.startsWith('/tools/')) {
    const toolName = decodeURIComponent(url.pathname.slice('/tools/'.length));
    if (!findToolDefinition(toolName)) {
      sendJson(res, 404, { error: 'Unknown Trace Flow tool: ' + toolName });
      return;
    }
    const args = await readRequestJson(req);
    const rawResult = await fetchTraceflowToolResult(toolName, args);
    sendJson(res, 200, unwrapTraceflowToolResult(rawResult));
    return;
  }
  sendJson(res, 404, { error: 'Not found' });
}

async function startTraceflowDataApi() {
  const server = http.createServer((req, res) => {
    void handleTraceflowDataApiRequest(req, res).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, { error: message });
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : undefined;
  if (!port) {
    server.close();
    throw new Error('Trace Flow Data API did not bind to a local port');
  }
  dataApiServer = server;
  dataApiBaseUrl = 'http://127.0.0.1:' + port;
  await fs.writeFile(
    dataApiDescriptorPath,
    JSON.stringify(
      {
        baseUrl: dataApiBaseUrl,
        openapiUrl: dataApiBaseUrl + '/openapi.json',
        toolsUrl: dataApiBaseUrl + '/tools',
      },
      null,
      2,
    ),
  );
  return { baseUrl: dataApiBaseUrl, openapiUrl: dataApiBaseUrl + '/openapi.json' };
}

async function stopTraceflowDataApi() {
  if (!dataApiServer) return;
  const server = dataApiServer;
  dataApiServer = undefined;
  await new Promise((resolve) => server.close(resolve));
}

async function post(pathname, body) {
  const response = await fetch(new URL(pathname, workerBaseUrl), {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + runToken,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(json?.error ?? 'Worker returned ' + response.status);
  }
  return json;
}

async function emit(event, options = {}) {
  if (options.markActivity !== false) lastActivityAt = Date.now();
  const next = { emittedAt: Date.now(), ...event };
  eventBuffer.push(next);
  console.log(JSON.stringify({ traceflow: next }));
  if (event.type !== 'stdout' || eventBuffer.length >= 8) await flushEvents();
}

function clearRunTimers() {
  clearTimeout(timeoutTimer);
  clearInterval(controlTimer);
  clearInterval(flushTimer);
  clearInterval(idleTimer);
  clearInterval(heartbeatTimer);
}

async function flushEvents() {
  flushQueue = flushQueue.then(flushEventsOnce, flushEventsOnce);
  return flushQueue;
}

async function flushEventsOnce() {
  if (eventBuffer.length === 0) return;
  const events = eventBuffer.splice(0, eventBuffer.length);
  // The event stream is the only way a run reports its state, so a failed POST must not be
  // swallowed. Retry with bounded backoff; on exhaustion re-queue (bounded) and record the
  // failure so it can't silently disappear. The watchdog's container-side post-mortem snapshot
  // is the out-of-band backstop that does not depend on this POST succeeding.
  for (let attempt = 0; attempt < EVENT_FLUSH_MAX_ATTEMPTS; attempt += 1) {
    try {
      await post('/pi-runs/events', { runId, events });
      consecutiveFlushFailures = 0;
      return;
    } catch (error) {
      if (attempt < EVENT_FLUSH_MAX_ATTEMPTS - 1) {
        await delay(EVENT_FLUSH_RETRY_BASE_MS * (attempt + 1));
        continue;
      }
      consecutiveFlushFailures += 1;
      console.error(
        'failed to flush ' +
          events.length +
          ' events after ' +
          EVENT_FLUSH_MAX_ATTEMPTS +
          ' attempts (consecutive failures: ' +
          consecutiveFlushFailures +
          ')',
        error,
      );
      const keep = events.slice(-EVENT_BUFFER_RETAIN);
      eventBuffer.unshift(...keep);
      if (eventBuffer.length > EVENT_BUFFER_MAX) {
        eventBuffer.splice(0, eventBuffer.length - EVENT_BUFFER_MAX);
      }
    }
  }
}

async function complete(status, payload = {}) {
  if (completed) return;
  completed = true;
  await flushEvents();
  await post('/pi-runs/complete', { runId, sandboxId, status, ...payload });
}

// A dying process MUST report its cause, never exit silently. uncaughtException /
// unhandledRejection give us an async window to emit a terminal 'failed' and POST it;
// only a hard SIGKILL (OOM) skips these, and that case is covered out-of-band by the
// Convex watchdog pulling the container's exit code + stderr (see plan A/D).
async function reportFatal(kind, error) {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  clearRunTimers();
  try {
    await emit({
      type: 'error',
      message: 'Runner ' + kind + ': ' + message,
      data: { kind, fatal: true },
    });
  } catch {
    // emit pushes to the buffer; complete() flushes below.
  }
  try {
    await complete('failed', { error: 'Runner ' + kind + ': ' + message });
  } catch (completeError) {
    console.error('reportFatal failed to post completion', completeError);
  }
}

process.on('uncaughtException', (error) => {
  void reportFatal('uncaught exception', error).finally(() => process.exit(1));
});
process.on('unhandledRejection', (reason) => {
  void reportFatal('unhandled rejection', reason).finally(() => process.exit(1));
});
process.on('exit', (code) => {
  // exit handlers are synchronous-only, so we cannot POST here. Leave a loud breadcrumb in
  // the container log (which the watchdog snapshot reads) when we exit non-zero without a
  // clean completion — this is the last-ditch signal before the process is gone.
  if (!completed && code !== 0) {
    console.error('runner exiting with code ' + code + ' before reporting completion');
  }
});

async function fetchTraceflowToolResult(toolName, args) {
  await flushEvents();
  const response = await post('/traceflow-data/tool', {
    runId,
    toolName,
    arguments: args ?? {},
  });
  return response.result;
}

// AgentState.errorMessage: 'Error message from the most recent failed or aborted assistant turn.'
function readAgentErrorMessage() {
  try {
    const message = session?.agent?.state?.errorMessage;
    return typeof message === 'string' && message.trim() ? message.trim() : undefined;
  } catch {
    return undefined;
  }
}

function readAgentTurnState() {
  try {
    const state = session?.agent?.state;
    if (!state) return undefined;
    return {
      isStreaming: Boolean(state.isStreaming),
      pendingToolCalls:
        state.pendingToolCalls && typeof state.pendingToolCalls.size === 'number'
          ? state.pendingToolCalls.size
          : undefined,
      errorMessage: readAgentErrorMessage(),
    };
  } catch {
    return undefined;
  }
}

function readSessionStats() {
  if (!session || typeof session.getSessionStats !== 'function') return undefined;
  try {
    const stats = session.getSessionStats();
    return {
      tokens: stats.tokens,
      cost: stats.cost,
      messages: {
        user: stats.userMessages,
        assistant: stats.assistantMessages,
        toolCalls: stats.toolCalls,
        toolResults: stats.toolResults,
        total: stats.totalMessages,
      },
      contextUsage: stats.contextUsage,
    };
  } catch {
    return undefined;
  }
}

async function emitUsage(reason) {
  const usage = readSessionStats();
  if (!usage) return;
  const signature = safeStringify(usage, 1000);
  if (signature === latestUsageSignature && reason !== 'final') return;
  latestUsageSignature = signature;
  await emit(
    {
      type: 'usage',
      message: 'Usage updated',
      data: { reason, usage },
    },
    { markActivity: false },
  );
}

async function emitHeartbeat() {
  const idleMs = Date.now() - lastActivityAt;
  const turn = readAgentTurnState();
  await emit(
    {
      type: 'status',
      message: 'Runner heartbeat',
      data: {
        phase: latestPhase,
        latestToolName,
        idleMs,
        piEventCount,
        resultTextChars: resultText.length,
        isStreaming: turn?.isStreaming ?? false,
        pendingToolCalls: turn?.pendingToolCalls,
        agentErrorMessage: turn?.errorMessage,
      },
    },
    { markActivity: false },
  );
  await emitUsage('heartbeat');
}

${PI_SYSTEM_PROMPT_SOURCE}

async function applyControls() {
  let text;
  try {
    text = await fs.readFile(controlPath, 'utf8');
  } catch {
    return;
  }
  const next = text.slice(controlOffset);
  const lines = next.split('\n');
  // Keep the trailing partial line (no newline yet) buffered for the next poll, so a control file
  // read mid-rewrite doesn't consume a torn line. Only advance past fully-terminated lines.
  const trailing = lines.pop() ?? '';
  controlOffset = text.length - trailing.length;
  for (const line of lines) {
    if (!line.trim()) continue;
    let control;
    try {
      control = JSON.parse(line);
    } catch {
      // A malformed/torn line must not crash the runner (unhandledRejection marks the run failed).
      continue;
    }
    await emit({ type: 'control', message: control.action, data: control });
    if (control.action === 'cancel') {
      await session?.abort();
      await complete('cancelled', { error: 'Run cancelled.' });
    } else if (control.action === 'steer' && control.message) {
      await session?.steer(control.message);
    } else if (control.action === 'follow_up' && control.message) {
      await session?.followUp(control.message);
    }
  }
}

async function completeFromIdleStream() {
  if (completed || timedOut) return;
  const idleMs = Date.now() - lastActivityAt;
  const text = resultText.trim();
  const fallbackText = latestToolResultText.trim();
  if (
    idleMs < IDLE_COMPLETION_MS ||
    (text.length < MIN_IDLE_COMPLETION_TEXT_CHARS && fallbackText.length === 0)
  ) {
    return;
  }

  clearRunTimers();
  await emitUsage('idle_completion');
  const fallbackResultText = [
    'Pi collected data, but the provider stream went idle before it produced a final narrative.',
    latestToolResultName ? 'Last completed tool: ' + latestToolResultName : '',
    fallbackText
      ? 'Last completed tool output, bounded for continuation synthesis:\n' +
        truncateText(fallbackText, 6000)
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  await emit({
    type: text ? 'status' : 'error',
    message: text
      ? 'Pi stream went idle; finalizing from streamed output'
      : 'Pi provider stream stalled after tool output; finalizing with bounded tool result',
    data: {
      idleMs,
      resultTextChars: text.length,
      latestToolResultName,
      latestToolResultChars: fallbackText.length,
    },
  });
  await session?.abort().catch(() => undefined);
  await complete('completed', {
    resultText:
      (text || fallbackResultText) +
      '\n\n[Trace Flow note: finalized after the Pi provider stream stopped producing events for ' +
      Math.round(idleMs / 1000) +
      's.]',
  });
}

try {
  await fs.mkdir(path.dirname(controlPath), { recursive: true });
  await fs.mkdir(agentDir, { recursive: true });
  await fs.rm(path.join(agentDir, 'extensions'), { recursive: true, force: true });
  await fs.rm('/workspace/.pi/extensions', { recursive: true, force: true });
  await fs.writeFile(contextGuardExtensionPath, buildTraceflowContextGuardExtension());
  await emit({
    type: 'status',
    message: 'Starting session',
    data: {
      phase: 'starting',
      trustedWorkspace: '/workspace',
      agentDir,
      discoveryTrust:
        'Trace Flow generates this trusted workspace and disables ambient Pi discovery.',
    },
  });
  const dataApi = await startTraceflowDataApi();
  await emit({
    type: 'status',
    message: 'Trace Flow Data API ready',
    data: {
      phase: 'data_api_ready',
      baseUrl: dataApi.baseUrl,
      openapiUrl: dataApi.openapiUrl,
      descriptorPath: dataApiDescriptorPath,
    },
  });
  await emit({
    type: 'status',
    message: 'Trace Flow context guard ready',
    data: {
      phase: 'context_guard_ready',
      extensionPath: contextGuardExtensionPath,
      maxToolResultChars: MAX_TOOL_RESULT_CONTEXT_CHARS,
      maxMessageChars: MAX_MESSAGE_CONTEXT_CHARS,
      maxProviderPayloadChars: MAX_PROVIDER_PAYLOAD_CHARS,
    },
  });
  await emit({
    type: 'status',
    message: 'Loading runtime',
    data: { phase: 'loading_runtime' },
  });
  timeoutTimer = setTimeout(() => {
    timedOut = true;
    void emitUsage('timeout');
    void emit({ type: 'error', message: 'Run timed out' });
    void session?.abort();
    void complete('timed_out', {
      error: 'Run timed out.',
      resultText: resultText.trim() || undefined,
    });
  }, request.maxRuntimeMs);

  // The SDK lives at /opt/pi/node_modules (outside /workspace) so a resume's overlay restore
  // can't shadow it. Bare ESM import() ignores NODE_PATH, and the package's exports map is
  // import-only (no require condition), so resolve its main from package.json and import that
  // absolute file URL directly.
  const piPkgDir = '/opt/pi/node_modules/@earendil-works/pi-coding-agent';
  const piPkg = JSON.parse(await fs.readFile(path.join(piPkgDir, 'package.json'), 'utf8'));
  const piMain = piPkg.exports?.['.']?.import ?? piPkg.module ?? piPkg.main ?? 'dist/index.js';
  const piEntry = pathToFileURL(path.join(piPkgDir, piMain)).href;
  const [
    { AuthStorage, createAgentSession, DefaultResourceLoader, ModelRegistry, SessionManager, SettingsManager },
  ] = await Promise.all([import(piEntry)]);
  await emit({ type: 'status', message: 'Runtime loaded' });

  const authStorage = AuthStorage.create(path.join(agentDir, 'auth.json'));
  authStorage.setRuntimeApiKey('traceflow-openrouter', runToken);
  const modelRegistry = ModelRegistry.create(authStorage, path.join(agentDir, 'models.json'));
  const model = modelRegistry.find('traceflow-openrouter', request.model);
  if (!model) throw new Error('Pi model not found: ' + request.model);

  const settingsManager = SettingsManager.inMemory(
    {
      defaultProjectTrust: 'always',
      quietStartup: true,
      enableAnalytics: false,
      enableInstallTelemetry: false,
      transport: 'sse',
      httpIdleTimeoutMs: PROVIDER_IDLE_TIMEOUT_MS,
      websocketConnectTimeoutMs: 30000,
      compaction: { enabled: true },
      retry: {
        enabled: true,
        maxRetries: 1,
        provider: {
          timeoutMs: PROVIDER_REQUEST_TIMEOUT_MS,
          maxRetries: 0,
          maxRetryDelayMs: 60000,
        },
      },
      packages: [],
      extensions: [contextGuardExtensionPath],
      skills: [],
      prompts: [],
      themes: [],
    },
    { projectTrusted: true },
  );
  const resourceLoader = new DefaultResourceLoader({
    cwd: '/workspace',
    agentDir,
    settingsManager,
    noExtensions: false,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: buildSystemPrompt,
  });
  await resourceLoader.reload({ resolveProjectTrust: async () => true });
  await emit({
    type: 'status',
    message: 'Runtime configured',
    data: {
      phase: 'runtime_configured',
      discovery: {
        extensions: ['traceflow-context-guard'],
        skills: false,
        promptTemplates: false,
        themes: false,
        contextFiles: false,
      },
      projectTrusted: true,
      trustBoundary:
        'Only Trace Flow-provided prompt, page context, tools, models, and run files are trusted.',
      providerTimeoutMs: PROVIDER_REQUEST_TIMEOUT_MS,
      providerIdleTimeoutMs: PROVIDER_IDLE_TIMEOUT_MS,
    },
  });

  // File-backed session so the conversation transcript survives the run. We snapshot
  // /workspace (data + this session dir) to R2 on completion and rehydrate it on the
  // next question, so a follow-up resumes with full prior context — see request.resume.
  const sessionDir = '/workspace/.pi/sessions';
  await fs.mkdir(sessionDir, { recursive: true });
  const sessionManager = request.resume
    ? SessionManager.continueRecent('/workspace', sessionDir)
    : SessionManager.create('/workspace', sessionDir);

  const created = await createAgentSession({
    cwd: '/workspace',
    agentDir,
    model,
    thinkingLevel: request.thinkingLevel ?? 'medium',
    authStorage,
    modelRegistry,
    tools: ['read', 'write', 'bash', 'grep', 'find', 'ls'],
    resourceLoader,
    sessionManager,
    settingsManager,
  });
  session = created.session;
  await emit({
    type: 'status',
    message: request.resume ? 'Resumed prior session' : 'Started new session',
    data: {
      phase: 'session_ready',
      resumed: Boolean(request.resume),
      sessionId: sessionManager.getSessionId(),
      persisted: sessionManager.isPersisted(),
    },
  });
  session.subscribe((event) => {
    piEventCount += 1;
    const displayEvent = describeSessionEvent(event);
    if (displayEvent) void emit(displayEvent);
    if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
      appendResultText(event.assistantMessageEvent.delta);
    }
    const turnText = resultTextFromEvent(event);
    if (turnText && !resultText.includes(turnText)) {
      appendResultText((resultText.trim() ? '\n\n' : '') + turnText);
    }
    const toolResultText = completedToolResultTextFromEvent(event);
    if (toolResultText) {
      latestToolResultText = toolResultText;
      latestToolResultName = typeof event.toolName === 'string' ? event.toolName : '';
    }
    if (
      event.type === 'message_end' ||
      event.type === 'turn_end' ||
      event.type === 'agent_end' ||
      event.type === 'tool_execution_end'
    ) {
      void emitUsage('pi_event');
    }
  });

  controlTimer = setInterval(() => void applyControls(), 2000);
  flushTimer = setInterval(() => void flushEvents(), 5000);
  idleTimer = setInterval(() => void completeFromIdleStream(), 5000);
  heartbeatTimer = setInterval(() => void emitHeartbeat(), HEARTBEAT_MS);

  try {
    await emit({
      type: 'status',
      message: 'Running analysis',
      data: { phase: 'running' },
    });
    await emitHeartbeat();
    await session.prompt(request.prompt);
    clearRunTimers();
    await emitUsage('final');
    // prompt() resolves even when the run failed: the SDK reports post-acceptance errors via the
    // event stream and session.agent.state.errorMessage, NOT by throwing. So a resolved prompt is
    // NOT proof of success — check the agent's error state before reporting 'completed'.
    const agentError = readAgentErrorMessage();
    if (timedOut) {
      await complete('timed_out', {
        error: 'Run timed out.',
        resultText: resultText.trim() || undefined,
      });
    } else if (agentError) {
      await emit({ type: 'error', message: agentError, data: { source: 'agent_state' } });
      await complete('failed', {
        error: agentError,
        resultText: resultText.trim() || undefined,
      });
    } else {
      await emit({ type: 'status', message: 'Analysis completed' });
      await complete('completed', {
        resultText: resultText.trim() || 'Pi completed without assistant text output.',
      });
    }
  } catch (error) {
    clearRunTimers();
    if (completed) {
      // Idle completion may abort the underlying SDK call after persisting a useful answer.
    } else {
      const message = error instanceof Error ? error.message : String(error);
      const status = timedOut ? 'timed_out' : completed ? 'cancelled' : 'failed';
      await emitUsage(status);
      await emit({ type: 'error', message });
      await complete(status, { error: message, resultText: resultText.trim() || undefined });
    }
  } finally {
    session?.dispose();
    await stopTraceflowDataApi();
  }
} catch (error) {
  clearRunTimers();
  const message = error instanceof Error ? error.message : String(error);
  await emitUsage('failed_startup');
  await emit({ type: 'error', message });
  await complete('failed', { error: message, resultText: resultText.trim() || undefined });
  await stopTraceflowDataApi();
}
`;
}
