import type { ToolCallResult } from '../protocol';

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
