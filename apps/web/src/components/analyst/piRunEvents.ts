import type { Id } from '@convex/_generated/dataModel';

// Presentation rows + their summaries are mapped on the server (the
// `listSandboxRunRows` query owns the grouping). The client only renders them,
// so it re-exports the types from the shared server module.
export type { PiRunRow, UsageSummary } from '@convex/analystPiRows';
import type { PiRunRow } from '@convex/analystPiRows';

export const CLIENT_RUN_TIMEOUT_GRACE_MS = 30_000;

export type SandboxRunStatus =
  | 'queued'
  | 'starting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'cancelled';

export type SandboxRun = {
  _id: Id<'analystSandboxRuns'>;
  _creationTime: number;
  status: SandboxRunStatus;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  lastEventAt?: number;
  maxRuntimeMs: number;
  nextSeq?: number;
  resultText?: string;
  error?: string;
  needsStatusRefresh?: boolean;
};

export type SandboxRunEvent = {
  _id: Id<'analystSandboxRunEvents'>;
  seq: number;
  type: string;
  message?: string;
  data?: unknown;
  emittedAt: number;
};

export type PiAgentStartOutput = {
  ok?: boolean;
  type: 'async_pi_agent_run';
  async?: boolean;
  runId?: string;
  status?: string;
  maxRuntimeMinutes?: number;
  message?: string;
  error?: string;
};

export function isActive(status: SandboxRunStatus) {
  return status === 'queued' || status === 'starting' || status === 'running';
}

function runStartMs(run: SandboxRun) {
  return run.startedAt ?? run._creationTime;
}

function latestRunEventMs(run: SandboxRun, events: SandboxRunEvent[] | undefined) {
  return Math.max(run.lastEventAt ?? 0, ...(events ?? []).map((event) => event.emittedAt));
}

export function clientTimeoutDeadlineMs(run: SandboxRun, events: SandboxRunEvent[] | undefined) {
  const latestEventAt = latestRunEventMs(run, events);
  const startDeadline = runStartMs(run) + run.maxRuntimeMs;
  if (!latestEventAt) return startDeadline;
  return Math.min(startDeadline, latestEventAt + run.maxRuntimeMs);
}

export function withClientDerivedTimeout(
  run: SandboxRun,
  events: SandboxRunEvent[] | undefined,
  now = Date.now(),
): SandboxRun {
  if (!isActive(run.status)) return run;
  const latestEventAt = latestRunEventMs(run, events);
  const deadline = clientTimeoutDeadlineMs(run, events);
  if (now < deadline + CLIENT_RUN_TIMEOUT_GRACE_MS) return run;

  const startedAt = latestEventAt ? Math.min(runStartMs(run), latestEventAt) : runStartMs(run);
  return {
    ...run,
    status: 'timed_out',
    startedAt,
    completedAt: deadline,
    lastEventAt: latestEventAt,
    error:
      run.error ??
      'Run exceeded its configured max runtime and the sandbox did not send a completion callback.',
  };
}

export function runtimeLabel(run: SandboxRun, now = Date.now()) {
  const start = runStartMs(run);
  const end = run.completedAt ?? now;
  const elapsedSeconds = Math.max(0, Math.round((end - start) / 1000));
  const maxMinutes = Math.round(run.maxRuntimeMs / 60_000);
  return `${elapsedSeconds}s elapsed, max ${maxMinutes}m`;
}

type RunActivity = {
  phase?: string;
  latestToolName?: string;
  idleMs?: number;
  piEventCount?: number;
  resultTextChars?: number;
};

export function latestRunActivity(
  run: SandboxRun,
  events: SandboxRunEvent[] | undefined,
  now = Date.now(),
): RunActivity | null {
  const eventList = events ?? [];
  const heartbeat = [...eventList]
    .reverse()
    .find((event) => isHeartbeatEvent(event) && isRecord(event.data));
  if (heartbeat && isRecord(heartbeat.data)) {
    return {
      phase: readString(heartbeat.data.phase),
      latestToolName: readString(heartbeat.data.latestToolName),
      idleMs: readNumber(heartbeat.data.idleMs),
      piEventCount: readNumber(heartbeat.data.piEventCount),
      resultTextChars: readNumber(heartbeat.data.resultTextChars),
    };
  }

  const latestStructured = [...eventList].reverse().find((event) => isRecord(event.data));
  if (!latestStructured || !isRecord(latestStructured.data)) {
    const latestEventAt = latestRunEventMs(run, events);
    return latestEventAt && isActive(run.status) ? { idleMs: now - latestEventAt } : null;
  }

  const data = latestStructured.data;
  const latestEventAt = latestRunEventMs(run, events);
  const phase =
    readString(data.phase) ??
    readString(data.eventType) ??
    readString(data.assistantEventType) ??
    readString(latestStructured.message) ??
    latestStructured.type;

  return {
    phase,
    latestToolName: readString(data.latestToolName) ?? readString(data.toolName),
    idleMs: isActive(run.status) && latestEventAt ? now - latestEventAt : undefined,
    piEventCount: run.nextSeq,
  };
}

function isHeartbeatEvent(event: SandboxRunEvent) {
  return event.type === 'status' && event.message === 'Runner heartbeat';
}

export function formatCount(value: number) {
  return Math.round(value).toLocaleString('en-US');
}

export function formatCost(value: number) {
  if (value === 0) return '$0.00';
  if (Math.abs(value) < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function readNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function buildFallbackRun(
  runId: Id<'analystSandboxRuns'>,
  output: PiAgentStartOutput,
  now = Date.now(),
): SandboxRun {
  const status = normalizeRunStatus(output.status);
  return {
    _id: runId,
    _creationTime: now,
    status,
    updatedAt: now,
    startedAt: now,
    maxRuntimeMs: Math.max(1, output.maxRuntimeMinutes ?? 60) * 60_000,
    error: output.error,
  };
}

function normalizeRunStatus(status: string | undefined): SandboxRunStatus {
  if (
    status === 'queued' ||
    status === 'starting' ||
    status === 'running' ||
    status === 'completed' ||
    status === 'failed' ||
    status === 'timed_out' ||
    status === 'cancelled'
  ) {
    return status;
  }
  return 'running';
}

export function isFinalRunEventDuplicate(run: SandboxRun, row: PiRunRow) {
  // The error renders separately below; everything else (the agent's full
  // narration and tool work) stays in the transcript. Nothing else is suppressed.
  if (run.error && row.kind === 'note' && row.label === 'Error') return true;
  return false;
}
