import type { Id } from './_generated/dataModel';

/**
 * Pure, server-owned mapping of sandbox run events into presentation-ready rows
 * for the Pi "Work log".
 *
 * The worker now persists CLEAN, typed, self-describing rows (see
 * `apps/analyst-sandbox/src/piRunner.ts` → `describeSessionEvent`): every event's
 * `data` already carries exactly the fields the work log needs. So this mapper is
 * a thin, dumb projection — no JSON-string parsing, no malformed-payload recovery,
 * no de-duping parallel tool tracks. Server groups, client renders.
 */

export interface SandboxRunEventInput {
  _id: Id<'analystSandboxRunEvents'>;
  seq: number;
  type: string;
  message?: string;
  data?: unknown;
  emittedAt: number;
}

export interface UsageSummary {
  totalTokens?: number;
  cacheRead?: number;
  totalCost?: number;
  contextPercent?: number;
}

/** Discriminated, presentation-ready event row. The renderer dispatches on `kind`. */
export type PiRunRow =
  | {
      kind: 'tool';
      key: string;
      toolName: string;
      command?: string;
      output?: string;
      isError?: boolean;
    }
  | {
      kind: 'text';
      key: string;
      text: string;
    }
  | {
      kind: 'note';
      key: string;
      label: string;
      text: string;
      tone?: 'danger' | 'normal';
    };

/**
 * Project the ordered run events into work-log rows.
 *
 * Usage snapshots are intentionally dropped here — per-step token/cost chips read
 * as noise scattered through the log. The run's total usage is surfaced once, in
 * the admin-only conversation cost summary (see `runUsageTotal`).
 */
export function toPiRunRows(events: SandboxRunEventInput[]): PiRunRow[] {
  const rows: PiRunRow[] = [];

  for (const event of events) {
    if (event.type === 'usage') continue;
    const row = toRow(event);
    if (row) rows.push(row);
  }

  return rows;
}

/**
 * The run's total usage. Pi emits cumulative usage snapshots, so the last parseable
 * `usage` event already holds the run total — no summing across snapshots needed.
 */
export function runUsageTotal(events: SandboxRunEventInput[]): UsageSummary | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type !== 'usage') continue;
    const usage = parseUsage(events[i].data);
    if (usage) return usage;
  }
  return null;
}

function toRow(event: SandboxRunEventInput): PiRunRow | null {
  const data = isRecord(event.data) ? event.data : null;
  const kind = data && typeof data.kind === 'string' ? data.kind : undefined;

  if (kind === 'tool') {
    return {
      kind: 'tool',
      key: event._id,
      toolName: readString(data?.toolName) ?? 'tool',
      command: readString(data?.command),
      output: readString(data?.output),
      isError: data?.isError === true,
    };
  }

  if (kind === 'text') {
    const text = readString(data?.text);
    return text ? { kind: 'text', key: event._id, text } : null;
  }

  // An informational note (e.g. "Resumed after interruption") emitted by the server,
  // not by Pi. Distinct from an error note via tone.
  if (kind === 'note') {
    const text = readString(data?.text);
    return text
      ? {
          kind: 'note',
          key: event._id,
          label: readString(data?.label) ?? 'Note',
          text,
          tone: data?.tone === 'danger' ? 'danger' : 'normal',
        }
      : null;
  }

  // A raw stderr/error event with no structured payload still surfaces as an error.
  if (event.type === 'error' || event.type === 'stderr') {
    const text = event.message?.trim();
    return text ? { kind: 'note', key: event._id, label: 'Error', text, tone: 'danger' } : null;
  }

  // status (heartbeats, lifecycle), control, and anything else are not work-log content.
  return null;
}

function parseUsage(data: unknown): UsageSummary | null {
  if (!isRecord(data) || !isRecord(data.usage)) return null;
  const usage = data.usage;
  const tokens = isRecord(usage.tokens) ? usage.tokens : null;
  const contextUsage = isRecord(usage.contextUsage) ? usage.contextUsage : null;

  const totalTokens = tokens
    ? (readNumber(tokens.totalTokens) ??
      readNumber(tokens.total) ??
      sumNumbers(tokens, ['input', 'output', 'cacheRead', 'cacheWrite']))
    : undefined;
  const cacheRead = tokens ? readNumber(tokens.cacheRead) : undefined;
  // In-sandbox pricing emits `cost` as a flat number (total USD); older snapshots
  // emit a `{ total, input, output, ... }` breakdown. Accept both.
  const totalCost = parseCost(usage.cost);
  const contextPercent = contextUsage
    ? (readNumber(contextUsage.percent) ?? readNumber(contextUsage.percentage))
    : undefined;

  if (
    totalTokens === undefined &&
    cacheRead === undefined &&
    totalCost === undefined &&
    contextPercent === undefined
  ) {
    return null;
  }
  return { totalTokens, cacheRead, totalCost, contextPercent };
}

/** `cost` is either a flat USD number or a `{ total, input, output, ... }` breakdown. */
function parseCost(cost: unknown): number | undefined {
  const flat = readNumber(cost);
  if (flat !== undefined) return flat;
  if (!isRecord(cost)) return undefined;
  return readNumber(cost.total) ?? sumNumbers(cost, ['input', 'output', 'cacheRead', 'cacheWrite']);
}

function sumNumbers(record: Record<string, unknown>, keys: string[]) {
  let total = 0;
  let found = false;
  for (const key of keys) {
    const value = readNumber(record[key]);
    if (value === undefined) continue;
    total += value;
    found = true;
  }
  return found ? total : undefined;
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
