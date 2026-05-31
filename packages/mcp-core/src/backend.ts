import type { TokenMinter } from './tinybird';

/**
 * Public-safe API key metadata. The raw key value is deliberately absent — it
 * never crosses the backend boundary, so neither the dispatch core nor the MCP
 * worker can leak it. Convex resolves ids→raw only inside its own mint path.
 */
export interface McpApiKeyMeta {
  id: string;
  name: string | null;
  expiresAt: number;
}

/**
 * Per-user org context the dispatch core needs to scope queries: whether the
 * user is still enabled, and the retention window their plan allows.
 */
export interface McpUserContext {
  enabled: boolean;
  retentionDays: number;
}

/**
 * Outcome of validating requested api_key_ids against what the user owns. A
 * value (not an exception) so the dispatch core can map bad ids to a JSON-RPC
 * InvalidParams without sniffing error strings, keeping caller-error distinct
 * from infra failure.
 */
export type ResolveKeyIdsResult =
  | { ok: true; keyIds: string[] }
  | { ok: false; invalidIds: string[] };

/**
 * Everything the MCP dispatch core needs that isn't pure computation. Convex
 * satisfies this inline (DB queries + the Tinybird-token action, resolving
 * ids→raw and orgId locally); the MCP worker satisfies it via shared-secret
 * calls to Convex. Ownership validation lives behind this boundary on both
 * hosts so raw keys never reach the worker.
 */
export interface McpBackend {
  mintToken: TokenMinter;

  /** Public metadata for the user's keys — drives list_api_keys and filtering. */
  listApiKeys(): Promise<McpApiKeyMeta[]>;

  /**
   * Validate that `requestedIds` are owned by the bound user and unexpired, or expand
   * to all owned unexpired ids when `requestedIds` is undefined. Enforced on
   * both hosts; the worker's backend re-validates server-side regardless.
   */
  resolveKeyIds(requestedIds?: string[]): Promise<ResolveKeyIdsResult>;

  getUserContext(): Promise<McpUserContext | null>;
}

/**
 * Pure id-ownership resolution shared by host adapters. `keys` must already be
 * filtered to unexpired. Returns the owned id set (all of them when no specific
 * ids were requested) or the offending ids.
 */
export function resolveApiKeyIds(
  keys: McpApiKeyMeta[],
  requestedIds?: string[],
): ResolveKeyIdsResult {
  if (!requestedIds || requestedIds.length === 0) {
    return { ok: true, keyIds: keys.map((k) => k.id) };
  }

  const owned = new Set(keys.map((k) => k.id));
  const invalidIds = requestedIds.filter((id) => !owned.has(id));
  if (invalidIds.length > 0) {
    return { ok: false, invalidIds };
  }
  return { ok: true, keyIds: requestedIds };
}
