import type { ToolCallResult } from '../protocol';
import type { ToolCtx } from '../tinybird';

// JSON formatting utilities

function formatNumber(value: number): number {
  if (value === 0 || !Number.isFinite(value)) return value;
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'number') {
    return formatNumber(value);
  }
  return value;
}

export function jsonToolResult(result: unknown): ToolCallResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(stripNulls(result), jsonReplacer) }],
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]';
}

export function stripNulls<T>(obj: T): T | undefined {
  if (obj === null || obj === undefined) return undefined;
  if (Array.isArray(obj)) {
    const filtered = obj.map(stripNulls).filter((v) => v !== undefined);
    return filtered.length > 0 ? (filtered as T) : undefined;
  }
  if (isPlainObject(obj)) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      const stripped = stripNulls(value);
      if (stripped !== undefined) result[key] = stripped;
    }
    return Object.keys(result).length > 0 ? (result as T) : undefined;
  }
  return obj;
}

export const TRACE_ID_PATTERN = /^[a-f0-9]{32}$/i;

export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 25;
export const DEFAULT_HOURS = 24;

export const DEFAULT_SPAN_LIMIT = 20;
export const MAX_SPAN_LIMIT = 100;

export const DEFAULT_EVENT_LIMIT = 20;
export const MAX_EVENT_LIMIT = 100;

export const DEFAULT_TRACE_SUMMARY_LIMIT = 20;
export const MAX_TRACE_SUMMARY_LIMIT = 100;

export const DEFAULT_ANALYTICS_LIMIT = 20;
export const MAX_ANALYTICS_LIMIT = 100;

export const DEFAULT_ANALYTICS_HOURS = 168;
export const MAX_ANALYTICS_HOURS = 24 * 180;

export function clampAnalyticsLimit(limit?: number): number {
  return Math.max(1, Math.min(limit ?? DEFAULT_ANALYTICS_LIMIT, MAX_ANALYTICS_LIMIT));
}

function clampLimit(limit: number | undefined, defaultLimit: number, maxLimit: number): number {
  return Math.max(1, Math.min(limit ?? defaultLimit, maxLimit));
}

interface OffsetPagination {
  limit: number;
  offset: number;
}

export function resolveOffsetPagination(
  limit: number | undefined,
  cursor: string | undefined,
  defaultLimit: number,
  maxLimit: number,
): OffsetPagination {
  const parsedOffset = cursor ? Number.parseInt(cursor, 10) : 0;
  return {
    limit: clampLimit(limit, defaultLimit, maxLimit),
    offset: Number.isFinite(parsedOffset) ? Math.max(0, parsedOffset) : 0,
  };
}

export function offsetPaginationResult(
  pagination: OffsetPagination,
  rowCount: number,
  totalCount: number,
  options: { includeLimit?: boolean; total?: number } = {},
): { has_more: boolean; next_cursor?: string; limit?: number; total?: number } {
  const hasMore = totalCount > pagination.offset + rowCount;
  return {
    has_more: hasMore,
    next_cursor: hasMore ? String(pagination.offset + rowCount) : undefined,
    limit: options.includeLimit ? pagination.limit : undefined,
    total: options.total,
  };
}

export function offsetPipeParams(
  startTimeNs: string,
  pagination: OffsetPagination,
): Record<string, string | number | undefined> {
  return {
    start_time_ns: startTimeNs,
    limit: pagination.limit,
    offset: pagination.offset,
  };
}

export function addOptionalPipeParams(
  target: Record<string, string | number | undefined>,
  source: object,
  keys: string[],
): void {
  const values = source as Record<string, unknown>;
  for (const key of keys) {
    const value = values[key];
    if ((typeof value === 'string' && value.length > 0) || typeof value === 'number') {
      target[key] = value;
    }
  }
}

export function tokenSummary(
  promptTokens: number,
  completionTokens: number,
  totalTokens: number,
): Record<string, number> | undefined {
  const tokens: Record<string, number> = {};
  if (promptTokens > 0) tokens.prompt = promptTokens;
  if (completionTokens > 0) tokens.completion = completionTokens;
  if (totalTokens > 0) tokens.total = totalTokens;
  return Object.keys(tokens).length > 0 ? tokens : undefined;
}

export function splitPatterns(patterns: string[]): { exact: string[]; prefixes: string[] } {
  const exact: string[] = [];
  const prefixes: string[] = [];
  for (const p of patterns) {
    if (p.endsWith('*') && p.length > 1) {
      prefixes.push(p.slice(0, -1));
    } else {
      exact.push(p);
    }
  }
  return { exact, prefixes };
}

export function addPatternParams(
  params: Record<string, string | number | undefined>,
  patterns: string[] | undefined,
  exactParam: string,
  prefixParam?: string,
): void {
  if (!patterns || patterns.length === 0) {
    return;
  }

  const { exact, prefixes } = splitPatterns(patterns);
  if (exact.length > 0) params[exactParam] = exact.join(',');
  if (prefixParam && prefixes.length > 0) params[prefixParam] = prefixes.join(',');
}

export async function mintPipeReadToken(
  ctx: ToolCtx,
  apiKeyIds: string[],
  retentionDays: number,
  pipes: string | string[],
): Promise<string> {
  const resources = Array.isArray(pipes) ? pipes : [pipes];
  return ctx.mintToken(
    resources.map((resource) => ({ type: 'PIPES:READ', resource })),
    apiKeyIds,
    retentionDays,
  );
}

interface MetricRow {
  count: number;
  duration_ms: number;
  cost_usd: number;
  tokens: number;
}

export function indexMetricRows<T extends MetricRow, K extends keyof T & string>(
  rows: T[],
  key: K,
): Record<string, MetricRow> {
  const indexed: Record<string, MetricRow> = {};
  for (const row of rows) {
    indexed[String(row[key])] = {
      count: row.count,
      duration_ms: row.duration_ms,
      cost_usd: row.cost_usd,
      tokens: row.tokens,
    };
  }
  return indexed;
}

export function buildTimeRangeNs(
  hours: number | undefined,
  defaultHours = DEFAULT_ANALYTICS_HOURS,
  maxHours = MAX_ANALYTICS_HOURS,
): { hours: number; startTimeNs: string; endTimeNs: string } {
  const requestedHours = hours ?? defaultHours;
  const finiteHours = Number.isFinite(requestedHours) ? requestedHours : defaultHours;
  const resolvedHours = Math.floor(Math.max(1, Math.min(finiteHours, maxHours)));
  const endEpochMs = BigInt(Date.now());
  const startEpochMs = endEpochMs - BigInt(resolvedHours) * 3_600_000n;
  return {
    hours: resolvedHours,
    startTimeNs: String(startEpochMs * 1_000_000n),
    endTimeNs: String(endEpochMs * 1_000_000n),
  };
}

export function noApiKeysError(): ToolCallResult {
  return {
    content: [{ type: 'text', text: 'No API keys configured. Please create an API key first.' }],
    isError: true,
  };
}

export function invalidTraceIdError(): ToolCallResult {
  return {
    content: [
      { type: 'text', text: 'Invalid trace ID format. Must be a 32-character hex string.' },
    ],
    isError: true,
  };
}

export function traceNotFoundError(traceId: string): ToolCallResult {
  return {
    content: [{ type: 'text', text: `Trace not found: ${traceId}` }],
    isError: true,
  };
}
