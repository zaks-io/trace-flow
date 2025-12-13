import { SignJWT } from 'jose';
import type { ToolCallResult } from '../protocol';

export const TRACE_ID_PATTERN = /^[a-f0-9]{32}$/i;

export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 25;
export const DEFAULT_HOURS = 24;
export const MAX_HOURS = 168;

export const DEFAULT_SPAN_LIMIT = 10;
export const MAX_SPAN_LIMIT = 100;

interface TinybirdResponse {
  data?: Record<string, unknown>[];
}

export async function queryTinybird(
  token: string,
  sql: string,
): Promise<Record<string, unknown>[]> {
  const apiUrl = process.env.TINYBIRD_API_URL ?? 'https://api.tinybird.co';
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

export async function generateTinybirdToken(
  scopes: { type: string; resource: string }[],
  ttlSeconds = 600,
): Promise<string> {
  const adminToken = process.env.TINYBIRD_ADMIN_TOKEN;
  const workspaceId = process.env.TINYBIRD_WORKSPACE_ID;

  if (!adminToken || !workspaceId) {
    throw new Error('Tinybird credentials not configured');
  }

  const payload = {
    workspace_id: workspaceId,
    name: `mcp_jwt_${Date.now()}`,
    scopes,
  };

  const secret = new TextEncoder().encode(adminToken);
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
    .sign(secret);
}
