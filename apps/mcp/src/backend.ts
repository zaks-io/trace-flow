import {
  resolveApiKeyIds,
  type McpApiKeyMeta,
  type McpBackend,
  type McpUserContext,
  type TinybirdScope,
} from '@trace-flow/mcp-core';

export class McpBackendError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'McpBackendError';
  }
}

interface ContextResponse {
  enabled: boolean;
  retentionDays: number;
  apiKeys: McpApiKeyMeta[];
}

interface WorkerBackendConfig {
  connectBaseUrl: string;
  sharedSecret: string;
}

/**
 * Worker-side `McpBackend`: forwards to the shared-secret `/mcp-backend/*`
 * routes on `connect.` so raw API keys and the Tinybird admin token stay in
 * Convex. The per-user `/context` response is fetched once and reused across
 * listApiKeys/resolveKeyIds/getUserContext within a request; only `mintToken`
 * makes a second call (it needs scopes the context fetch doesn't know).
 */
export function createWorkerBackend(userId: string, config: WorkerBackendConfig): McpBackend {
  const { connectBaseUrl, sharedSecret } = config;
  let contextPromise: Promise<ContextResponse | null> | null = null;

  const post = async (path: string, body: unknown): Promise<Response> =>
    fetch(new URL(path, connectBaseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sharedSecret}`,
      },
      body: JSON.stringify(body),
    });

  const getContext = (): Promise<ContextResponse | null> => {
    contextPromise ??= (async () => {
      const res = await post('/mcp-backend/context', { userId });
      if (res.status === 404) return null;
      if (!res.ok) throw new McpBackendError('context fetch failed', res.status);
      const body: ContextResponse = await res.json();
      return body;
    })();
    return contextPromise;
  };

  return {
    mintToken: async (
      scopes: TinybirdScope[],
      apiKeyIds: string[],
      _retentionDays: number,
      ttlSeconds?: number,
    ): Promise<string> => {
      // retentionDays is re-derived server-side from the user's tier; the worker
      // is untrusted and doesn't supply it.
      const res = await post('/mcp-backend/mint', { userId, scopes, apiKeyIds, ttlSeconds });
      if (!res.ok) throw new McpBackendError('mint failed', res.status);
      const { token }: { token: string } = await res.json();
      return token;
    },
    listApiKeys: async (): Promise<McpApiKeyMeta[]> => {
      const ctx = await getContext();
      return ctx?.apiKeys ?? [];
    },
    resolveKeyIds: async (requestedIds) => {
      const ctx = await getContext();
      return resolveApiKeyIds(ctx?.apiKeys ?? [], requestedIds);
    },
    getUserContext: async (): Promise<McpUserContext | null> => {
      const ctx = await getContext();
      return ctx ? { enabled: ctx.enabled, retentionDays: ctx.retentionDays } : null;
    },
  };
}
