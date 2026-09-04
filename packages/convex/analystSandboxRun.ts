import type { Doc } from './_generated/dataModel';
import type { PageContextReference } from './analyst';
import { isSandboxRunTimeoutExpired, sandboxRunDeadlineMs } from './analystSandboxPolicy';

export const MAX_PROMPT_CHARS = 20_000;
const MAX_PAGE_CONTEXT_REFS = 12;
const DEFAULT_PI_RUNTIME_MS = 60 * 60 * 1000;
const MAX_PI_RUNTIME_MS = 120 * 60 * 1000;
export const MAX_SANDBOX_EVENT_BATCH = 50;
export const MAX_SANDBOX_EVENT_MESSAGE_CHARS = 20_000;
export const MAX_SANDBOX_RESULT_CHARS = 120_000;
export const SANDBOX_START_FETCH_TIMEOUT_MS = 180_000;

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

export function normalizeUnknownPageContextReferences(value: unknown): PageContextReference[] {
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

export function clampPiRuntimeMs(maxRuntimeMinutes: number | undefined): number {
  if (!maxRuntimeMinutes || !Number.isFinite(maxRuntimeMinutes)) return DEFAULT_PI_RUNTIME_MS;
  return Math.min(Math.max(Math.round(maxRuntimeMinutes * 60 * 1000), 60_000), MAX_PI_RUNTIME_MS);
}

export function truncateText(value: string | undefined, maxChars: number): string | undefined {
  if (!value) return value;
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated]`;
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function createSandboxRunToken(): Promise<{ token: string; hash: string }> {
  const token = randomHex(32);
  return { token, hash: await sha256Hex(token) };
}

export function buildPiSandboxId(): string {
  return `pi-${randomHex(12)}`;
}

export function summarizeSandboxRun(run: Doc<'analystSandboxRuns'>) {
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
