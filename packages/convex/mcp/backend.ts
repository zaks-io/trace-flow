import type { ActionCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import {
  resolveApiKeyIds,
  type McpApiKeyMeta,
  type McpBackend,
  type McpUserContext,
} from '@trace-flow/mcp-core';
import { RETENTION_DAYS } from '@trace-flow/types';

/**
 * Adapts the Convex action ctx to the host-agnostic `McpBackend` the dispatch
 * core in `@trace-flow/mcp-core` expects. Bound to one `userId` per request so
 * `mintToken` can resolve owned key ids → raw keys and the org id locally — raw
 * keys and the Tinybird admin token never leave Convex.
 *
 * Both the in-process MCP handler (during transition) and the shared-secret
 * `/mcp-backend/*` routes the dedicated MCP worker calls use this same adapter,
 * so the row-security boundary is identical regardless of who dispatches.
 */
export function createMcpBackend(ctx: ActionCtx, userId: Id<'users'>): McpBackend {
  // One key fetch per request, shared across listApiKeys/resolveKeyIds/mintToken.
  let keysPromise: ReturnType<typeof loadKeys> | null = null;
  const loadKeys = () => ctx.runQuery(internal.apiKeys.listForUser, { userId });
  const getKeys = () => (keysPromise ??= loadKeys());

  const unexpiredMeta = async (): Promise<McpApiKeyMeta[]> => {
    const now = Date.now();
    return (await getKeys())
      .filter((k) => k.expiresAt > now)
      .map((k) => ({ id: k._id, name: k.name ?? null, expiresAt: k.expiresAt }));
  };

  return {
    mintToken: async (scopes, apiKeyIds, retentionDays, ttlSeconds) => {
      const keys = await getKeys();
      const ids = new Set(apiKeyIds);
      const rawKeys = keys.filter((k) => ids.has(k._id)).map((k) => k.key);
      const user = await ctx.runQuery(internal.auth.users.getUserById, { id: userId });
      return ctx.runAction(internal.integrations.tinybird.generateTokenInternal, {
        scopes,
        apiKeys: rawKeys,
        retentionDays,
        orgId: user?.orgId,
        ttl: ttlSeconds,
      });
    },
    listApiKeys: () => unexpiredMeta(),
    resolveKeyIds: async (_userId, requestedIds) =>
      resolveApiKeyIds(await unexpiredMeta(), requestedIds),
    getUserContext: async (): Promise<McpUserContext | null> => {
      const user = await ctx.runQuery(internal.auth.users.getUserById, { id: userId });
      if (!user) return null;
      const subscription = user.orgId
        ? await ctx.runQuery(internal.billing.subscriptions.getByOrgId, { orgId: user.orgId })
        : null;
      const tier = subscription?.tier ?? 'hobby';
      return {
        enabled: user.enabled,
        retentionDays: RETENTION_DAYS[tier] ?? RETENTION_DAYS.hobby,
      };
    },
  };
}
