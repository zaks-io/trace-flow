export const MAX_CODE_CHARS = 20_000;
export const MAX_DATASETS = 5;
const MAX_DATASET_TEXT_CHARS = 250_000;
export const MAX_STDOUT_CHARS = 60_000;
export const MAX_STDERR_CHARS = 20_000;
export const EXECUTION_TIMEOUT_MS = 45_000;
export const MAX_PI_PROMPT_CHARS = 20_000;
export const MAX_PI_RUNTIME_MS = 120 * 60 * 1000;
const MIN_PI_RUNTIME_MS = 60_000;
export const MAX_PI_CONTROL_MESSAGE_CHARS = 8_000;
export const MAX_PI_TAIL_LINES = 500;
const MAX_PI_TOOL_DEFINITIONS_CHARS = 100_000;

export type PiThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
const PI_THINKING_LEVELS: readonly PiThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
];
/** Analyst runs reason by default; callers may override per run. Not 'off' — we want thinking. */
export const DEFAULT_PI_THINKING_LEVEL: PiThinkingLevel = 'medium';

export interface AnalysisDataset {
  name: string;
  tool: string;
  arguments: Record<string, unknown>;
  resultText: string;
}

export interface ExecuteAnalysisRequest {
  sandboxId: string;
  code: string;
  datasets: AnalysisDataset[];
}

export interface StartPiRunRequest {
  runId: string;
  runToken: string;
  sandboxId: string;
  prompt: string;
  pageContextReferences: unknown[];
  maxRuntimeMs: number;
  model: string;
  thinkingLevel: PiThinkingLevel;
  toolDefinitions: unknown[];
  /** Rehydrate prior /workspace + Pi session from R2 and resume it instead of starting fresh. */
  resume: boolean;
  /** Backup handle to restore when resume is true. Serializable metadata from createBackup(). */
  backup?: { id: string; dir: string; localBucket?: boolean };
}

export interface ControlPiRunRequest {
  runId: string;
  sandboxId: string;
  processId?: string;
  action: 'status' | 'tail' | 'cancel' | 'steer' | 'follow_up';
  message?: string;
  tailLimit?: number;
}

export interface DestroyPiRunRequest {
  sandboxId: string;
  processId?: string;
}

export interface TraceflowToolRequest {
  runId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

export type ParseResult<T = ExecuteAnalysisRequest> =
  | { ok: true; request: T }
  | { ok: false; error: string };

const DATASET_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const SANDBOX_ID_PATTERN = /^[A-Za-z0-9_-]{1,63}$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const TOKEN_PATTERN = /^[A-Fa-f0-9]{64}$/;

function parseObjectArguments(value: unknown): ParseResult<Record<string, unknown>> {
  if (value === undefined || value === null) return { ok: true, request: {} };

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return { ok: true, request: {} };
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, error: 'Invalid arguments' };
      }
      return { ok: true, request: parsed as Record<string, unknown> };
    } catch {
      return { ok: false, error: 'Invalid arguments' };
    }
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'Invalid arguments' };
  }

  return { ok: true, request: value as Record<string, unknown> };
}

function timingSafeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);

  for (let i = 0; i < length; i += 1) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }

  return diff === 0;
}

export function isAuthorized(authorization: string | null, secret: string): boolean {
  if (!authorization?.startsWith('Bearer ')) return false;
  return timingSafeEqual(authorization.slice('Bearer '.length), secret);
}

export function parseExecuteAnalysisRequest(value: unknown): ParseResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'Payload must be an object' };
  }

  const payload = value as Record<string, unknown>;
  if (typeof payload.sandboxId !== 'string' || !SANDBOX_ID_PATTERN.test(payload.sandboxId)) {
    return { ok: false, error: 'Invalid sandboxId' };
  }
  if (typeof payload.code !== 'string' || payload.code.length === 0) {
    return { ok: false, error: 'Code is required' };
  }
  if (payload.code.length > MAX_CODE_CHARS) {
    return { ok: false, error: 'Code is too long' };
  }
  if (!Array.isArray(payload.datasets)) {
    return { ok: false, error: 'datasets must be an array' };
  }
  if (payload.datasets.length > MAX_DATASETS) {
    return { ok: false, error: 'Too many datasets' };
  }

  const datasets: AnalysisDataset[] = [];
  for (const item of payload.datasets) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, error: 'Invalid dataset' };
    }

    const dataset = item as Record<string, unknown>;
    if (typeof dataset.name !== 'string' || !DATASET_NAME_PATTERN.test(dataset.name)) {
      return { ok: false, error: 'Invalid dataset name' };
    }
    if (typeof dataset.tool !== 'string' || dataset.tool.length === 0) {
      return { ok: false, error: 'Invalid dataset tool' };
    }
    if (typeof dataset.resultText !== 'string') {
      return { ok: false, error: 'Invalid dataset resultText' };
    }
    if (dataset.resultText.length > MAX_DATASET_TEXT_CHARS) {
      return { ok: false, error: 'Dataset is too large' };
    }
    if (
      dataset.arguments !== undefined &&
      (!dataset.arguments ||
        typeof dataset.arguments !== 'object' ||
        Array.isArray(dataset.arguments))
    ) {
      return { ok: false, error: 'Invalid dataset arguments' };
    }

    datasets.push({
      name: dataset.name,
      tool: dataset.tool,
      arguments: (dataset.arguments as Record<string, unknown> | undefined) ?? {},
      resultText: dataset.resultText,
    });
  }

  return {
    ok: true,
    request: {
      sandboxId: payload.sandboxId,
      code: payload.code,
      datasets,
    },
  };
}

export function parseStartPiRunRequest(value: unknown): ParseResult<StartPiRunRequest> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'Payload must be an object' };
  }

  const payload = value as Record<string, unknown>;
  if (typeof payload.runId !== 'string' || !RUN_ID_PATTERN.test(payload.runId)) {
    return { ok: false, error: 'Invalid runId' };
  }
  if (typeof payload.runToken !== 'string' || !TOKEN_PATTERN.test(payload.runToken)) {
    return { ok: false, error: 'Invalid runToken' };
  }
  if (typeof payload.sandboxId !== 'string' || !SANDBOX_ID_PATTERN.test(payload.sandboxId)) {
    return { ok: false, error: 'Invalid sandboxId' };
  }
  if (typeof payload.prompt !== 'string' || payload.prompt.trim().length === 0) {
    return { ok: false, error: 'Prompt is required' };
  }
  if (payload.prompt.length > MAX_PI_PROMPT_CHARS) {
    return { ok: false, error: 'Prompt is too long' };
  }
  if (
    typeof payload.maxRuntimeMs !== 'number' ||
    !Number.isFinite(payload.maxRuntimeMs) ||
    payload.maxRuntimeMs < MIN_PI_RUNTIME_MS ||
    payload.maxRuntimeMs > MAX_PI_RUNTIME_MS
  ) {
    return { ok: false, error: 'Invalid maxRuntimeMs' };
  }
  if (
    typeof payload.model !== 'string' ||
    payload.model.length === 0 ||
    payload.model.length > 200
  ) {
    return { ok: false, error: 'Invalid model' };
  }
  if (
    payload.thinkingLevel !== undefined &&
    !PI_THINKING_LEVELS.includes(payload.thinkingLevel as PiThinkingLevel)
  ) {
    return { ok: false, error: 'Invalid thinkingLevel' };
  }
  if (!Array.isArray(payload.pageContextReferences)) {
    return { ok: false, error: 'pageContextReferences must be an array' };
  }
  if (!Array.isArray(payload.toolDefinitions)) {
    return { ok: false, error: 'toolDefinitions must be an array' };
  }
  if (JSON.stringify(payload.toolDefinitions).length > MAX_PI_TOOL_DEFINITIONS_CHARS) {
    return { ok: false, error: 'toolDefinitions is too large' };
  }

  return {
    ok: true,
    request: {
      runId: payload.runId,
      runToken: payload.runToken,
      sandboxId: payload.sandboxId,
      prompt: payload.prompt,
      pageContextReferences: payload.pageContextReferences,
      maxRuntimeMs: Math.round(payload.maxRuntimeMs),
      model: payload.model,
      thinkingLevel: (payload.thinkingLevel as PiThinkingLevel) ?? DEFAULT_PI_THINKING_LEVEL,
      toolDefinitions: payload.toolDefinitions,
      resume: payload.resume === true,
      backup: parseBackupHandle(payload.backup),
    },
  };
}

function parseBackupHandle(value: unknown): StartPiRunRequest['backup'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const handle = value as Record<string, unknown>;
  if (typeof handle.id !== 'string' || typeof handle.dir !== 'string') return undefined;
  return {
    id: handle.id,
    dir: handle.dir,
    localBucket: handle.localBucket === true,
  };
}

export function parseControlPiRunRequest(value: unknown): ParseResult<ControlPiRunRequest> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'Payload must be an object' };
  }

  const payload = value as Record<string, unknown>;
  if (typeof payload.runId !== 'string' || !RUN_ID_PATTERN.test(payload.runId)) {
    return { ok: false, error: 'Invalid runId' };
  }
  if (typeof payload.sandboxId !== 'string' || !SANDBOX_ID_PATTERN.test(payload.sandboxId)) {
    return { ok: false, error: 'Invalid sandboxId' };
  }
  if (
    payload.processId !== undefined &&
    (typeof payload.processId !== 'string' || payload.processId.length > 128)
  ) {
    return { ok: false, error: 'Invalid processId' };
  }
  if (
    payload.action !== 'status' &&
    payload.action !== 'tail' &&
    payload.action !== 'cancel' &&
    payload.action !== 'steer' &&
    payload.action !== 'follow_up'
  ) {
    return { ok: false, error: 'Invalid action' };
  }
  if (
    payload.message !== undefined &&
    (typeof payload.message !== 'string' || payload.message.length > MAX_PI_CONTROL_MESSAGE_CHARS)
  ) {
    return { ok: false, error: 'Invalid message' };
  }
  if (
    payload.tailLimit !== undefined &&
    (typeof payload.tailLimit !== 'number' ||
      !Number.isFinite(payload.tailLimit) ||
      payload.tailLimit < 1 ||
      payload.tailLimit > MAX_PI_TAIL_LINES)
  ) {
    return { ok: false, error: 'Invalid tailLimit' };
  }

  return {
    ok: true,
    request: {
      runId: payload.runId,
      sandboxId: payload.sandboxId,
      processId: payload.processId,
      action: payload.action,
      message: payload.message,
      tailLimit:
        typeof payload.tailLimit === 'number'
          ? Math.min(Math.max(Math.round(payload.tailLimit), 1), MAX_PI_TAIL_LINES)
          : undefined,
    },
  };
}

export function parseDestroyPiRunRequest(value: unknown): ParseResult<DestroyPiRunRequest> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'Payload must be an object' };
  }

  const payload = value as Record<string, unknown>;
  if (typeof payload.sandboxId !== 'string' || !SANDBOX_ID_PATTERN.test(payload.sandboxId)) {
    return { ok: false, error: 'Invalid sandboxId' };
  }
  if (payload.processId !== undefined && typeof payload.processId !== 'string') {
    return { ok: false, error: 'Invalid processId' };
  }

  return {
    ok: true,
    request: {
      sandboxId: payload.sandboxId,
      processId: payload.processId,
    },
  };
}

export function parseTraceflowToolRequest(value: unknown): ParseResult<TraceflowToolRequest> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'Payload must be an object' };
  }

  const payload = value as Record<string, unknown>;
  if (typeof payload.runId !== 'string' || !RUN_ID_PATTERN.test(payload.runId)) {
    return { ok: false, error: 'Invalid runId' };
  }
  if (typeof payload.toolName !== 'string' || payload.toolName.length === 0) {
    return { ok: false, error: 'Invalid toolName' };
  }
  const parsedArguments = parseObjectArguments(payload.arguments);
  if (!parsedArguments.ok) return parsedArguments;

  return {
    ok: true,
    request: {
      runId: payload.runId,
      toolName: payload.toolName,
      arguments: parsedArguments.request,
    },
  };
}

export function truncateOutput(
  value: string,
  maxChars: number,
): { value: string; truncated: boolean } {
  if (value.length <= maxChars) return { value, truncated: false };
  return { value: `${value.slice(0, maxChars)}\n...[truncated]`, truncated: true };
}

export function buildPythonScript(request: ExecuteAnalysisRequest): string {
  const datasetsJson = JSON.stringify(request.datasets);
  const userCodeJson = JSON.stringify(request.code);

  return `import json
import traceback

TRACEFLOW_DATASETS = {item["name"]: item for item in json.loads(${JSON.stringify(datasetsJson)})}

def dataset(name):
    if name not in TRACEFLOW_DATASETS:
        raise KeyError(f"Unknown dataset: {name}")
    return TRACEFLOW_DATASETS[name]

try:
    _globals = {
        "TRACEFLOW_DATASETS": TRACEFLOW_DATASETS,
        "dataset": dataset,
    }
    exec(compile(${userCodeJson}, "<traceflow-analysis>", "exec"), _globals)
    if "analysis_result" in _globals:
        print("__TRACEFLOW_ANALYSIS_RESULT__" + json.dumps(_globals["analysis_result"], default=str))
except Exception:
    traceback.print_exc()
    raise
`;
}
