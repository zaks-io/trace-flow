/**
 * Result shapes for the stateless MCP revisions (2026-07-28 and later): every
 * result carries `resultType`, list results carry cache hints, and the server
 * identifies itself in `_meta`.
 *
 * Spec: https://modelcontextprotocol.io/specification/2026-07-28/server/discover
 */
import {
  MCP_SERVER_CAPABILITIES,
  MCP_SERVER_INFO,
  SUPPORTED_PROTOCOL_VERSIONS,
  type JsonRpcResponse,
} from './protocol';
import { META_SERVER_INFO } from './request-metadata';
import { createSuccessResponse } from './handler';

/**
 * Tools change only on deploy and deploys have no purge step, so this TTL bounds
 * how long a client may keep a stale list. Responses sit behind per-user auth,
 * so shared intermediaries must not cache them.
 */
export const RESULT_CACHE_HINTS = { ttlMs: 300_000, cacheScope: 'private' } as const;

export interface DiscoverResult {
  resultType: 'complete';
  supportedVersions: string[];
  capabilities: typeof MCP_SERVER_CAPABILITIES;
  _meta: { [META_SERVER_INFO]: typeof MCP_SERVER_INFO };
  ttlMs: number;
  cacheScope: 'private';
}

function serverMeta(existing: unknown): Record<string, unknown> {
  const base =
    typeof existing === 'object' && existing !== null && !Array.isArray(existing) ? existing : {};
  return { ...base, [META_SERVER_INFO]: { ...MCP_SERVER_INFO } };
}

/** Stamps a legacy-shaped response with the fields every modern result requires. */
export function toModernResponse(
  response: JsonRpcResponse,
  extra?: typeof RESULT_CACHE_HINTS,
): JsonRpcResponse {
  if (typeof response.result !== 'object' || response.result === null) return response;
  const result = response.result as Record<string, unknown>;
  return {
    ...response,
    result: { ...result, ...extra, resultType: 'complete', _meta: serverMeta(result._meta) },
  };
}

export function handleServerDiscover(id: string | number): JsonRpcResponse {
  const result: DiscoverResult = {
    resultType: 'complete',
    supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
    capabilities: MCP_SERVER_CAPABILITIES,
    _meta: { [META_SERVER_INFO]: { ...MCP_SERVER_INFO } },
    ...RESULT_CACHE_HINTS,
  };
  return createSuccessResponse(id, result);
}
