import { getSandbox, type Sandbox as SandboxBinding } from '@cloudflare/sandbox';
import { getPricing } from '@trace-flow/pricing';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import {
  buildPiModelsJson,
  buildPiRunnerScript,
  buildPiRunRequest,
  buildPiWorkspaceManifest,
  getPiRunnerPaths,
  pricingToPiCost,
  type PiModelCost,
} from './piRunner';
import { buildTraceflowPythonClient } from './pythonClient';
import {
  EXECUTION_TIMEOUT_MS,
  MAX_PI_TAIL_LINES,
  MAX_STDERR_CHARS,
  MAX_STDOUT_CHARS,
  buildPythonScript,
  isAuthorized,
  parseControlPiRunRequest,
  parseDestroyPiRunRequest,
  parseExecuteAnalysisRequest,
  parseStartPiRunRequest,
  parseTraceflowToolRequest,
  truncateOutput,
} from './request';

export { Sandbox } from '@cloudflare/sandbox';

interface Env {
  Sandbox: DurableObjectNamespace<SandboxBinding>;
  ANALYST_SANDBOX_SHARED_SECRET: string;
  CONVEX_URL: string;
  OPENROUTER_API_KEY: string;
  BACKUP_BUCKET: R2Bucket;
  BACKUP_LOCAL_BUCKET: string;
  MODEL_PRICING: KVNamespace;
}

/**
 * Pi prices each run in-sandbox, so we bake the model's real rates into models.json at launch.
 * Rates come from the same MODEL_PRICING KV (models.dev/OpenRouter-sourced) the consumers use, so
 * there is one pricing source of truth. Fails loud if the model is unpriced — never silently $0.
 */
async function resolvePiModelCost(env: Env, model: string): Promise<PiModelCost> {
  const pricing = await getPricing(env.MODEL_PRICING, 'openrouter', model);
  if (!pricing) {
    throw new Error(`No MODEL_PRICING entry for openrouter:${model}; cannot price Pi run`);
  }
  return pricingToPiCost(pricing);
}

/** Days a /workspace snapshot survives in R2 before automatic GC (matches an idle conversation). */
const BACKUP_TTL_SECONDS = 7 * 24 * 60 * 60;

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return Response.json(value, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...init?.headers,
    },
  });
}

const receiveEventsRef = makeFunctionReference<'action'>('analyst:receiveSandboxEvents');
const completeRunRef = makeFunctionReference<'action'>('analyst:completeSandboxRun');
const checkpointRunRef = makeFunctionReference<'action'>('analyst:checkpointSandboxRun');
const executeToolRef = makeFunctionReference<'action'>('analyst:executeSandboxToolCall');
const verifyRunRef = makeFunctionReference<'action'>('analyst:verifySandboxRunToken');
const SANDBOX_RPC_TIMEOUT_MS = 8_000;
const SANDBOX_CLEANUP_TIMEOUT_MS = 5_000;
const SANDBOX_START_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 12_000, 16_000];

function getConvex(env: Env) {
  if (!env.CONVEX_URL) throw new Error('CONVEX_URL is not configured');
  return new ConvexHttpClient(env.CONVEX_URL);
}

function getAnalystSandbox(env: Env, sandboxId: string, options: { keepAlive?: boolean } = {}) {
  return getSandbox(env.Sandbox, sandboxId, {
    enableDefaultSession: false,
    keepAlive: options.keepAlive,
  });
}

interface WorkspaceBackup {
  id: string;
  dir: string;
  localBucket?: boolean;
}

/** Snapshot /workspace to R2. Returns the serializable handle, or null if it fails. */
async function snapshotWorkspace(env: Env, sandboxId: string): Promise<WorkspaceBackup | null> {
  try {
    const sandbox = getAnalystSandbox(env, sandboxId);
    const backup = await sandbox.createBackup({
      dir: '/workspace',
      name: sandboxId,
      ttl: BACKUP_TTL_SECONDS,
      localBucket: env.BACKUP_LOCAL_BUCKET === 'true',
    });
    return { id: backup.id, dir: backup.dir, localBucket: backup.localBucket };
  } catch (error) {
    console.error('snapshotWorkspace failed', error);
    return null;
  }
}

/** Rehydrate /workspace from a prior backup handle. Returns true on success. */
async function restoreWorkspace(
  sandbox: ReturnType<typeof getAnalystSandbox>,
  backup: WorkspaceBackup,
): Promise<boolean> {
  try {
    const result = await sandbox.restoreBackup(backup);
    return result.success;
  } catch (error) {
    console.error('restoreWorkspace failed', error);
    return false;
  }
}

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get('authorization');
  return authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : null;
}

function fileContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const content = (value as { content?: unknown }).content;
  return typeof content === 'string' ? content : '';
}

function dateLike(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return undefined;
}

function serializeProcess(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  const process = value as {
    id?: unknown;
    pid?: unknown;
    command?: unknown;
    status?: unknown;
    startTime?: unknown;
    endTime?: unknown;
    exitCode?: unknown;
    sessionId?: unknown;
  };
  return {
    id: typeof process.id === 'string' ? process.id : undefined,
    pid: typeof process.pid === 'number' ? process.pid : undefined,
    command: typeof process.command === 'string' ? process.command : undefined,
    status: typeof process.status === 'string' ? process.status : undefined,
    startTime: dateLike(process.startTime),
    endTime: dateLike(process.endTime),
    exitCode: typeof process.exitCode === 'number' ? process.exitCode : undefined,
    sessionId: typeof process.sessionId === 'string' ? process.sessionId : undefined,
  };
}

function tailText(value: string, lineLimit: number, charLimit: number) {
  const bounded = truncateOutput(value, charLimit);
  const lines = bounded.value.split(/\r?\n/);
  if (lines.length <= lineLimit) return bounded;
  return {
    value: `[showing last ${lineLimit} lines]\n${lines.slice(-lineLimit).join('\n')}`,
    truncated: true,
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableSandboxStartError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /container is starting|retry in a moment|503 service unavailable/i.test(message);
}

async function sandboxStartupStep<T>(label: string, run: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= SANDBOX_START_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      if (!isRetryableSandboxStartError(error) || attempt >= SANDBOX_START_RETRY_DELAYS_MS.length) {
        throw error;
      }
      await sleep(SANDBOX_START_RETRY_DELAYS_MS[attempt] ?? 1_000);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`${label} failed`);
}

async function sandboxRpc<T>(
  label: string,
  operation: Promise<T>,
  timeoutMs = SANDBOX_RPC_TIMEOUT_MS,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function readProcessSnapshot(
  sandbox: ReturnType<typeof getAnalystSandbox>,
  processId: string | undefined,
  tailLimit = 100,
) {
  const lineLimit = Math.min(Math.max(Math.round(tailLimit), 1), MAX_PI_TAIL_LINES);
  const diagnostics: string[] = [];
  const processResult = processId
    ? await sandboxRpc('getProcess', sandbox.getProcess(processId))
    : ({ ok: true, value: null } as const);
  const process = processResult.ok
    ? processResult.value
    : {
        id: processId,
        status: 'unreachable',
        error: processResult.error,
      };
  if (!processResult.ok) diagnostics.push(processResult.error);

  const processesResult = await sandboxRpc('listProcesses', sandbox.listProcesses());
  const processes = processesResult.ok ? processesResult.value : [];
  if (!processesResult.ok) diagnostics.push(processesResult.error);

  const logsResult = processId
    ? await sandboxRpc('getProcessLogs', sandbox.getProcessLogs(processId))
    : ({ ok: true, value: null } as const);
  const logs =
    processId && logsResult.ok && logsResult.value
      ? {
          processId: logsResult.value.processId,
          stdout: tailText(logsResult.value.stdout, lineLimit, MAX_STDOUT_CHARS),
          stderr: tailText(logsResult.value.stderr, lineLimit, MAX_STDERR_CHARS),
        }
      : processId
        ? {
            processId,
            stdout: { value: '', truncated: false },
            stderr: {
              value: logsResult.ok ? '' : logsResult.error,
              truncated: false,
            },
          }
        : null;
  if (!logsResult.ok) diagnostics.push(logsResult.error);

  return {
    process: serializeProcess(process),
    processes: processes.map(serializeProcess).filter(Boolean),
    logs,
    diagnostics,
  };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/ai-proxy/openrouter/')) {
      return handleOpenRouterProxy(request, env, url);
    }

    if (request.method !== 'POST') {
      return jsonResponse({ ok: false, error: 'Not found' }, { status: 404 });
    }

    if (url.pathname === '/execute') {
      return handleExecuteAnalysis(request, env);
    }
    if (url.pathname === '/pi-runs/start') {
      return handleStartPiRun(request, env, url);
    }
    if (url.pathname === '/pi-runs/control') {
      return handleControlPiRun(request, env, ctx);
    }
    if (url.pathname === '/pi-runs/destroy') {
      return handleDestroyPiRun(request, env);
    }
    if (url.pathname === '/pi-runs/events') {
      return handlePiRunEvents(request, env);
    }
    if (url.pathname === '/pi-runs/complete') {
      return handlePiRunComplete(request, env, ctx);
    }
    if (url.pathname === '/pi-runs/checkpoint') {
      return handlePiRunCheckpoint(request, env);
    }
    if (url.pathname === '/traceflow-data/tool') {
      return handleTraceflowTool(request, env);
    }

    return jsonResponse({ ok: false, error: 'Not found' }, { status: 404 });
  },
};

async function handleExecuteAnalysis(request: Request, env: Env): Promise<Response> {
  if (!isAuthorized(request.headers.get('authorization'), env.ANALYST_SANDBOX_SHARED_SECRET)) {
    return jsonResponse({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const parsed = parseExecuteAnalysisRequest(await request.json().catch(() => null));
  if (!parsed.ok) {
    return jsonResponse({ ok: false, error: parsed.error }, { status: 400 });
  }

  const sandbox = getAnalystSandbox(env, parsed.request.sandboxId);
  try {
    const scriptPath = '/workspace/traceflow_analysis.py';
    await sandbox.writeFile(scriptPath, buildPythonScript(parsed.request));

    const result = await sandbox.exec(
      'env -i HOME=/workspace PATH=/usr/local/bin:/usr/bin:/bin python3 /workspace/traceflow_analysis.py',
      {
        cwd: '/workspace',
        timeout: EXECUTION_TIMEOUT_MS,
      },
    );

    const stdout = truncateOutput(result.stdout, MAX_STDOUT_CHARS);
    const stderr = truncateOutput(result.stderr, MAX_STDERR_CHARS);

    return jsonResponse({
      ok: result.success,
      exitCode: result.exitCode,
      durationMs: result.duration,
      stdout: stdout.value,
      stderr: stderr.value,
      truncated: stdout.truncated || stderr.truncated,
    });
  } catch (error) {
    return jsonResponse(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  } finally {
    await sandbox.destroy().catch(() => undefined);
  }
}

async function handleStartPiRun(request: Request, env: Env, url: URL): Promise<Response> {
  if (!isAuthorized(request.headers.get('authorization'), env.ANALYST_SANDBOX_SHARED_SECRET)) {
    return jsonResponse({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const parsed = parseStartPiRunRequest(await request.json().catch(() => null));
  if (!parsed.ok) return jsonResponse({ ok: false, error: parsed.error }, { status: 400 });

  const body = parsed.request;
  const sandbox = getAnalystSandbox(env, body.sandboxId, { keepAlive: true });
  const paths = getPiRunnerPaths(body.runId);
  const aiProxyBaseUrl = `${url.origin}/ai-proxy/openrouter/${body.runId}/api/v1`;

  // Rehydrate the prior /workspace (data + Pi session) before writing this run's
  // files, so the runner's continueRecent() picks up exactly where it left off.
  // If restore fails, fall through as a cold start rather than aborting the run.
  let resumed = false;
  if (body.resume && body.backup) {
    resumed = await restoreWorkspace(sandbox, body.backup);
  }
  // The runner resumes the Pi session only if the workspace actually rehydrated.
  const runBody = { ...body, resume: resumed };

  try {
    const modelCost = await sandboxStartupStep('resolve model pricing', () =>
      resolvePiModelCost(env, body.model),
    );
    await sandboxStartupStep('mkdir run dir', () =>
      sandbox.mkdir(paths.runDir, { recursive: true }),
    );
    await sandboxStartupStep('mkdir Pi agent dir', () =>
      sandbox.mkdir('/workspace/.pi/agent', { recursive: true }),
    );
    await sandboxStartupStep('write request', () =>
      sandbox.writeFile(paths.requestPath, buildPiRunRequest(runBody)),
    );
    await sandboxStartupStep('write Pi models', () =>
      sandbox.writeFile(
        '/workspace/.pi/agent/models.json',
        buildPiModelsJson(body.model, aiProxyBaseUrl, modelCost),
      ),
    );
    await sandboxStartupStep('write workspace manifest', () =>
      sandbox.writeFile('/workspace/TRACEFLOW_RUNNER.md', buildPiWorkspaceManifest()),
    );
    await sandboxStartupStep('write Trace Flow Python client', () =>
      sandbox.writeFile(
        '/workspace/traceflow_client.py',
        buildTraceflowPythonClient(body.toolDefinitions),
      ),
    );
    await sandboxStartupStep('write runner', () =>
      sandbox.writeFile(paths.runnerPath, buildPiRunnerScript()),
    );
    await sandboxStartupStep('write control file', () => sandbox.writeFile(paths.controlPath, ''));

    const process = await sandboxStartupStep('start Pi runner', () =>
      sandbox.startProcess('node /workspace/traceflow-pi-runner.mjs', {
        cwd: '/workspace',
        processId: `pi-${body.runId}`,
        timeout: body.maxRuntimeMs + 60_000,
        env: {
          TRACEFLOW_RUN_ID: body.runId,
          TRACEFLOW_RUN_TOKEN: body.runToken,
          TRACEFLOW_SANDBOX_ID: body.sandboxId,
          TRACEFLOW_WORKER_BASE_URL: url.origin,
          TRACEFLOW_REQUEST_PATH: paths.requestPath,
          TRACEFLOW_CONTROL_PATH: paths.controlPath,
          HOME: '/workspace',
          USER: 'traceflow',
          XDG_CONFIG_HOME: '/workspace/.config',
          XDG_CACHE_HOME: '/workspace/.cache',
          NODE_ENV: 'production',
          PI_CODING_AGENT_DIR: '/workspace/.pi/agent',
          PI_CODING_AGENT_SESSION_DIR: '/workspace/.pi/sessions',
          PI_CACHE_RETENTION: 'long',
          PI_OFFLINE: '1',
          PI_SKIP_VERSION_CHECK: '1',
          PI_TELEMETRY: '0',
        },
        autoCleanup: true,
      }),
    );

    return jsonResponse({ ok: true, processId: process.id, pid: process.pid });
  } catch (error) {
    console.error('handleStartPiRun failed', error);
    await sandbox.destroy().catch(() => undefined);
    return jsonResponse(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

async function handleDestroyPiRun(request: Request, env: Env): Promise<Response> {
  if (!isAuthorized(request.headers.get('authorization'), env.ANALYST_SANDBOX_SHARED_SECRET)) {
    return jsonResponse({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const parsed = parseDestroyPiRunRequest(await request.json().catch(() => null));
  if (!parsed.ok) return jsonResponse({ ok: false, error: parsed.error }, { status: 400 });

  const sandbox = getAnalystSandbox(env, parsed.request.sandboxId);
  if (parsed.request.processId) {
    await sandboxRpc(
      'killProcess',
      sandbox.killProcess(parsed.request.processId),
      SANDBOX_CLEANUP_TIMEOUT_MS,
    );
  }
  await sandboxRpc('setKeepAlive(false)', sandbox.setKeepAlive(false), SANDBOX_CLEANUP_TIMEOUT_MS);
  await sandboxRpc('destroy sandbox', sandbox.destroy(), SANDBOX_CLEANUP_TIMEOUT_MS);

  return jsonResponse({ ok: true });
}

async function handleControlPiRun(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (!isAuthorized(request.headers.get('authorization'), env.ANALYST_SANDBOX_SHARED_SECRET)) {
    return jsonResponse({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const parsed = parseControlPiRunRequest(await request.json().catch(() => null));
  if (!parsed.ok) return jsonResponse({ ok: false, error: parsed.error }, { status: 400 });

  const body = parsed.request;
  const sandbox = getAnalystSandbox(env, body.sandboxId);
  const paths = getPiRunnerPaths(body.runId);
  const shouldWriteControl = !['status', 'tail'].includes(body.action);

  if (shouldWriteControl) {
    const line = JSON.stringify({
      action: body.action,
      message: body.message,
      at: Date.now(),
    });

    const existingResult = await sandboxRpc(
      'read control file',
      sandbox.readFile(paths.controlPath),
    );
    const existing = existingResult.ok ? fileContent(existingResult.value) : '';
    await sandboxRpc(
      'write control file',
      sandbox.writeFile(paths.controlPath, `${existing}${line}\n`),
    );
    if (body.action === 'cancel' && body.processId) {
      await sandboxRpc(
        'killProcess',
        sandbox.killProcess(body.processId),
        SANDBOX_CLEANUP_TIMEOUT_MS,
      );
    }
  }

  const snapshot = await readProcessSnapshot(sandbox, body.processId, body.tailLimit);

  if (body.action === 'cancel') {
    ctx.waitUntil(
      Promise.all([
        sandboxRpc('setKeepAlive(false)', sandbox.setKeepAlive(false), SANDBOX_CLEANUP_TIMEOUT_MS),
        sandboxRpc('destroy sandbox', sandbox.destroy(), SANDBOX_CLEANUP_TIMEOUT_MS),
      ]).then(() => undefined),
    );
  }

  return jsonResponse({ ok: true, ...snapshot });
}

async function handlePiRunEvents(request: Request, env: Env): Promise<Response> {
  const token = bearerToken(request);
  if (!token) return jsonResponse({ ok: false, error: 'Unauthorized' }, { status: 401 });
  const body = (await request.json().catch(() => null)) as {
    runId?: string;
    events?: unknown[];
  } | null;
  if (!body?.runId || !Array.isArray(body.events)) {
    return jsonResponse({ ok: false, error: 'Invalid events payload' }, { status: 400 });
  }

  await getConvex(env).action(receiveEventsRef, {
    runId: body.runId,
    token,
    events: body.events,
  });
  return jsonResponse({ ok: true });
}

async function handlePiRunComplete(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const token = bearerToken(request);
  if (!token) return jsonResponse({ ok: false, error: 'Unauthorized' }, { status: 401 });
  const body = (await request.json().catch(() => null)) as {
    runId?: string;
    sandboxId?: string;
    status?: string;
    resultText?: string;
    error?: string;
  } | null;
  if (
    !body?.runId ||
    !['completed', 'failed', 'timed_out', 'cancelled'].includes(String(body.status))
  ) {
    return jsonResponse({ ok: false, error: 'Invalid completion payload' }, { status: 400 });
  }

  // Snapshot /workspace (data + Pi session transcript) to R2 BEFORE teardown, but
  // only for a clean completion — a failed/timed-out run must not clobber the last
  // good snapshot. The serializable handle is stored on the thread by Convex so the
  // next question can rehydrate and resume.
  let backup: { id: string; dir: string; localBucket?: boolean } | null = null;
  if (body.sandboxId && body.status === 'completed') {
    backup = await snapshotWorkspace(env, body.sandboxId);
  }

  await getConvex(env).action(completeRunRef, {
    runId: body.runId,
    token,
    status: body.status,
    resultText: body.resultText,
    error: body.error,
    backup: backup ?? undefined,
  });

  if (body.sandboxId) {
    const sandbox = getAnalystSandbox(env, body.sandboxId);
    ctx.waitUntil(
      sandbox
        .setKeepAlive(false)
        .catch(() => undefined)
        .then(() => sandbox.destroy().catch(() => undefined)),
    );
  }

  return jsonResponse({ ok: true });
}

async function handlePiRunCheckpoint(request: Request, env: Env): Promise<Response> {
  const token = bearerToken(request);
  if (!token) return jsonResponse({ ok: false, error: 'Unauthorized' }, { status: 401 });
  const body = (await request.json().catch(() => null)) as {
    runId?: string;
    sandboxId?: string;
  } | null;
  if (!body?.runId || !body.sandboxId) {
    return jsonResponse({ ok: false, error: 'Invalid checkpoint payload' }, { status: 400 });
  }

  const backup = await snapshotWorkspace(env, body.sandboxId);
  if (!backup) return jsonResponse({ ok: false, error: 'Snapshot failed' }, { status: 500 });

  await getConvex(env).action(checkpointRunRef, {
    runId: body.runId,
    token,
    backup,
  });

  return jsonResponse({ ok: true });
}

async function handleTraceflowTool(request: Request, env: Env): Promise<Response> {
  const token = bearerToken(request);
  if (!token) return jsonResponse({ ok: false, error: 'Unauthorized' }, { status: 401 });
  const parsed = parseTraceflowToolRequest(await request.json().catch(() => null));
  if (!parsed.ok) return jsonResponse({ ok: false, error: parsed.error }, { status: 400 });

  try {
    const result: unknown = await getConvex(env).action(executeToolRef, {
      runId: parsed.request.runId,
      token,
      toolName: parsed.request.toolName,
      arguments: parsed.request.arguments,
    });
    return jsonResponse(result);
  } catch (error) {
    return jsonResponse(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}

async function handleOpenRouterProxy(request: Request, env: Env, url: URL): Promise<Response> {
  const token = bearerToken(request);
  if (!token) return jsonResponse({ ok: false, error: 'Unauthorized' }, { status: 401 });
  if (!env.OPENROUTER_API_KEY) {
    return jsonResponse(
      { ok: false, error: 'OPENROUTER_API_KEY is not configured' },
      { status: 500 },
    );
  }

  const match = /^\/ai-proxy\/openrouter\/([^/]+)\/api\/v1\/(.+)$/.exec(url.pathname);
  const runId = match?.[1];
  const targetPath = match?.[2];
  if (!runId || !targetPath)
    return jsonResponse({ ok: false, error: 'Invalid proxy path' }, { status: 404 });

  const verified = (await getConvex(env).action(verifyRunRef, { runId, token })) as {
    ok?: boolean;
    status?: string | null;
  };
  if (!verified.ok || !['queued', 'starting', 'running'].includes(String(verified.status))) {
    return jsonResponse({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const headers = new Headers(request.headers);
  headers.set('authorization', `Bearer ${env.OPENROUTER_API_KEY}`);
  headers.set('HTTP-Referer', 'https://traceflow.dev');
  headers.set('X-Title', 'Trace Flow Analyst Pi');
  headers.delete('host');
  headers.delete('content-length');

  let body: BodyInit | null = null;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const text = await request.text();
    body = maybeAddOpenRouterMetadata(text, runId);
  }

  return fetch(`https://openrouter.ai/api/v1/${targetPath}${url.search}`, {
    method: request.method,
    headers,
    body,
  });
}

function maybeAddOpenRouterMetadata(text: string, runId: string): string {
  try {
    const payload = JSON.parse(text) as Record<string, unknown>;
    payload.session_id = runId;
    payload.usage = { include: true };
    return JSON.stringify(payload);
  } catch {
    return text;
  }
}
