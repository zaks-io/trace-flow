import { fetchPipe, type PipeParam } from '@trace-flow/tinybird-client';

export interface TinybirdScope {
  type: string;
  resource: string;
}

/**
 * Mints a per-org Tinybird query JWT for a set of OWNED api-key ids. Raw key
 * strings and the Tinybird admin token never cross this boundary — Convex
 * resolves ids→raw locally before signing; the MCP worker forwards the ids to a
 * shared-secret backend that resolves and signs server-side. Tools pass through
 * the opaque id list dispatch hands them, never raw keys. Ids are pre-validated
 * as owned (see {@link McpBackend.resolveKeyIds}), so this throws only on infra
 * failure.
 */
export type TokenMinter = (
  scopes: TinybirdScope[],
  apiKeyIds: string[],
  retentionDays: number,
  ttlSeconds?: number,
) => Promise<string>;

/**
 * Everything a tool needs that isn't pure: minting a scoped token and the
 * Tinybird base URL. Injected so the same tool code runs inside Convex and the
 * worker with no `process.env` reads.
 */
export interface ToolCtx {
  mintToken: TokenMinter;
  tinybirdBaseUrl: string;
}

/**
 * Bearer-token fetch of a Tinybird Pipe with 403-retry semantics already baked
 * in by the shared client.
 */
export async function queryPipe(
  baseUrl: string,
  token: string,
  pipe: string,
  params?: Record<string, PipeParam>,
): Promise<Record<string, unknown>[]> {
  return fetchPipe<Record<string, unknown>>({
    baseUrl,
    token,
    pipe,
    params,
    retry: true,
  });
}
