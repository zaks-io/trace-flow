/**
 * Pure decision logic for the Pi sandbox run lifecycle. No `ctx`, no I/O: every
 * function takes plain data and returns a verdict or a plan that a handler then
 * executes. This is the testable core of the sandbox state machine — the scary
 * branches (timeout, liveness, auto-resume, continuation-gating) live here so
 * they can be unit-tested without standing up a sandbox or a Convex deployment.
 */

export const SANDBOX_TIMEOUT_WATCHDOG_GRACE_MS = 30_000;
// Liveness watchdog: the runner heartbeats every ~10s, so no event for this long
// while the run is active means the container died (deploy rollout, eviction, crash).
export const SANDBOX_LIVENESS_STALE_MS = 30_000;
// Auto-resume a dead container up to this many times before failing loudly, so a
// run that crashes on every start can't loop forever burning tokens and containers.
export const SANDBOX_MAX_RESUME_ATTEMPTS = 2;

export const ACTIVE_SANDBOX_RUN_STATUSES = new Set(['queued', 'starting', 'running']);

export function isActiveSandboxRunStatus(status: string): boolean {
  return ACTIVE_SANDBOX_RUN_STATUSES.has(status);
}

export interface SandboxRunTiming {
  _creationTime: number;
  status: string;
  startedAt?: number;
  maxRuntimeMs: number;
}

export function sandboxRunDeadlineMs(run: SandboxRunTiming): number {
  return (run.startedAt ?? run._creationTime) + run.maxRuntimeMs;
}

/**
 * Milliseconds left before an active run is considered timed out, or `null` when
 * the run is already terminal. 0 means expired now.
 */
export function sandboxRunTimeoutRemainingMs(
  run: SandboxRunTiming,
  now: number,
  graceMs = SANDBOX_TIMEOUT_WATCHDOG_GRACE_MS,
): number | null {
  if (!isActiveSandboxRunStatus(run.status)) return null;
  return Math.max(0, sandboxRunDeadlineMs(run) + graceMs - now);
}

export function isSandboxRunTimeoutExpired(
  run: SandboxRunTiming,
  now: number,
  graceMs = SANDBOX_TIMEOUT_WATCHDOG_GRACE_MS,
): boolean {
  return sandboxRunTimeoutRemainingMs(run, now, graceMs) === 0;
}

export interface SandboxRunLiveness {
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

/** Process snapshot shape the post-mortem reads, narrowed to what the cause line needs. */
export interface SandboxProcessSnapshot {
  id?: string;
  status?: string;
  exitCode?: number;
}

/**
 * One-line human cause for a dead run's terminal message, e.g.
 * "process pi-abc is killed with exit code 137" (137 = 128 + SIGKILL = OOM). Returns undefined
 * when there's genuinely nothing to say.
 */
export function describeSandboxProcessCause(
  process: SandboxProcessSnapshot | null | undefined,
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

/**
 * Whether a completed run should schedule the conversation continuation. Mirrors
 * the guard in the continuation-scheduling mutation: only a fresh `completed`
 * run that actually produced result text and hasn't already been scheduled.
 */
export function shouldScheduleContinuation(run: {
  status: string;
  resultText?: string;
  continuationScheduledAt?: number;
}): boolean {
  if (run.continuationScheduledAt) return false;
  return run.status === 'completed' && Boolean(run.resultText);
}

export type DeadRunRecoveryPlan =
  | { action: 'resume'; resumeAttempt: number }
  | { action: 'give_up'; attempts: number };

/**
 * Given how many times a dead run has already been auto-resumed, decide whether the
 * next recovery should relaunch from checkpoint or give up. The caller pulls the
 * post-mortem and relaunches; this owns only the resume-attempt cap so a
 * crash-looping run fails loudly instead of resuming forever.
 */
export function planDeadRunRecovery(
  run: { resumeAttempt?: number },
  maxAttempts = SANDBOX_MAX_RESUME_ATTEMPTS,
): DeadRunRecoveryPlan {
  const attempt = run.resumeAttempt ?? 0;
  if (attempt >= maxAttempts) return { action: 'give_up', attempts: attempt };
  return { action: 'resume', resumeAttempt: attempt + 1 };
}

export interface SandboxControlProcess {
  id?: string;
  status?: string;
  pid?: number;
  exitCode?: number;
  startTime?: string;
  endTime?: string;
}

export interface SandboxControlResponse {
  ok?: boolean;
  process?: SandboxControlProcess | null;
  processes?: unknown[];
  logs?: {
    processId?: string;
    stdout?: { value?: string; truncated?: boolean };
    stderr?: { value?: string; truncated?: boolean };
  } | null;
  diagnostics?: string[];
}

export interface SandboxControlEvent {
  type: 'status' | 'stdout' | 'stderr';
  message?: string;
  data?: unknown;
  emittedAt?: number;
}

const MAX_SANDBOX_LOG_EVENT_CHARS = 8_000;

function sandboxLogMessage(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= MAX_SANDBOX_LOG_EVENT_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_SANDBOX_LOG_EVENT_CHARS)}\n...[truncated]`;
}

/**
 * Project a sandbox control/status response into the run events that describe it:
 * a status (or stderr if the process wasn't found) line, plus any stdout/stderr
 * and diagnostic tails. Pure so the event shape is unit-testable.
 */
export function buildSandboxControlEvents(
  run: { processId?: string },
  response: SandboxControlResponse,
): SandboxControlEvent[] {
  const process = response.process ?? null;
  const processId = process?.id ?? run.processId ?? 'unknown';
  const status = process?.status ?? 'not_found';
  const exitCode =
    process && typeof process.exitCode === 'number' ? ` with exit code ${process.exitCode}` : '';
  const message =
    status === 'not_found'
      ? `Sandbox process ${processId} was not found. It may have exited before sending events.`
      : `Sandbox process ${processId} is ${status}${exitCode}.`;
  const events: SandboxControlEvent[] = [
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
    .filter((value): value is string => Boolean(value));
  for (const diagnostic of diagnostics) {
    events.push({ type: 'stderr', message: diagnostic, data: { processId } });
  }

  return events;
}
