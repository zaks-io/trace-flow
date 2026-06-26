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
      kind: 'usage';
      key: string;
      usage: UsageSummary;
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
 * The only "grouping" left is collapsing the stream of `usage` snapshots into a
 * single trailing summary — everything else is already one clean row per event.
 */
export function toPiRunRows(events: SandboxRunEventInput[]): PiRunRow[] {
  const rows: PiRunRow[] = [];
  let latestUsage: { key: string; usage: UsageSummary } | null = null;

  for (const event of events) {
    if (event.type === 'usage') {
      const usage = parseUsage(event.data);
      if (usage) latestUsage = { key: `${event._id}:usage`, usage };
      continue;
    }

    const row = toRow(event);
    if (row) rows.push(row);
  }

  if (latestUsage) {
    rows.push({ kind: 'usage', key: latestUsage.key, usage: latestUsage.usage });
  }

  return rows;
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
  const cost = isRecord(usage.cost) ? usage.cost : null;
  const contextUsage = isRecord(usage.contextUsage) ? usage.contextUsage : null;

  const totalTokens = tokens
    ? (readNumber(tokens.totalTokens) ??
      readNumber(tokens.total) ??
      sumNumbers(tokens, ['input', 'output', 'cacheRead', 'cacheWrite']))
    : undefined;
  const cacheRead = tokens ? readNumber(tokens.cacheRead) : undefined;
  const totalCost = cost
    ? (readNumber(cost.total) ?? sumNumbers(cost, ['input', 'output', 'cacheRead', 'cacheWrite']))
    : undefined;
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
