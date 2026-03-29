import { SignJWT } from 'jose';
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

export function stripNulls<T>(obj: T): T | undefined {
  if (obj === null || obj === undefined) return undefined;
  if (Array.isArray(obj)) {
    const filtered = obj.map(stripNulls).filter((v) => v !== undefined);
    return filtered.length > 0 ? (filtered as T) : undefined;
  }
  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
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
export const MAX_HOURS = 168;

export const DEFAULT_SPAN_LIMIT = 20;
export const MAX_SPAN_LIMIT = 100;

export const DEFAULT_ANALYTICS_HOURS = 168;
export const MAX_ANALYTICS_HOURS = 24 * 180;

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
  const resolvedHours = Math.min(hours ?? defaultHours, maxHours);
  const endTimeMs = BigInt(Date.now());
  const startTimeMs = endTimeMs - BigInt(resolvedHours) * 3_600_000n;
  return {
    hours: resolvedHours,
    startTimeNs: String(startTimeMs * 1_000_000n),
    endTimeNs: String(endTimeMs * 1_000_000n),
  };
}

interface TinybirdResponse {
  data?: Record<string, unknown>[];
}

export async function queryTinybird(
  token: string,
  sql: string,
): Promise<Record<string, unknown>[]> {
  const apiUrl = process.env.TINYBIRD_API_URL ?? 'https://api.us-west-2.aws.tinybird.co';
  const url = new URL(`${apiUrl}/v0/sql`);
  url.searchParams.set('q', sql);

  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`TinyBird query failed: ${response.status} - ${text}`);
  }

  const result: TinybirdResponse = await response.json();
  return result.data ?? [];
}

export async function queryTinybirdPipe(
  token: string,
  pipe: string,
  params: Record<string, string | number | undefined> = {},
): Promise<Record<string, unknown>[]> {
  const apiUrl = process.env.TINYBIRD_API_URL ?? 'https://api.us-west-2.aws.tinybird.co';
  const url = new URL(`${apiUrl}/v0/pipes/${pipe}.json`);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`TinyBird pipe query failed: ${response.status} - ${text}`);
  }

  const result: TinybirdResponse = await response.json();
  return result.data ?? [];
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

interface TinybirdScope {
  type: string;
  resource: string;
  fixed_params?: Record<string, unknown>;
}

export async function generateTinybirdToken(
  scopes: { type: string; resource: string }[],
  apiKeys: string[],
  ttlSeconds = 600,
): Promise<string> {
  const adminToken = process.env.TINYBIRD_ADMIN_TOKEN;
  const workspaceId = process.env.TINYBIRD_WORKSPACE_ID;

  if (!adminToken || !workspaceId) {
    throw new Error('Tinybird credentials not configured');
  }

  // Add api_keys to fixed_params for row-level security
  // Use sentinel value when no keys to prevent matching empty strings
  const apiKeyString = apiKeys.join(',') || '__NO_KEYS__';
  const scopesWithApiKeys: TinybirdScope[] = scopes.map((scope) => ({
    ...scope,
    fixed_params: { api_keys: apiKeyString },
  }));

  const payload = {
    workspace_id: workspaceId,
    name: `mcp_jwt_${Date.now()}`,
    scopes: scopesWithApiKeys,
  };

  const secret = new TextEncoder().encode(adminToken);
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
    .sign(secret);
}
