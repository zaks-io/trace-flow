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

const BACKEND_REQUEST_TIMEOUT_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isApiKeyMeta(value: unknown): value is McpApiKeyMeta {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    (typeof value.name === 'string' || value.name === null) &&
    typeof value.expiresAt === 'number'
  );
}

function isContextResponse(value: unknown): value is ContextResponse {
  return (
    isRecord(value) &&
    typeof value.enabled === 'boolean' &&
    typeof value.retentionDays === 'number' &&
    Array.isArray(value.apiKeys) &&
    value.apiKeys.every(isApiKeyMeta)
  );
}

async function parseJsonResponse(res: Response, malformedMessage: string): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    throw new McpBackendError(malformedMessage, 502);
  }
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

  const post = async (path: string, body: unknown): Promise<Response> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(new Error('Backend request timed out')),
      BACKEND_REQUEST_TIMEOUT_MS,
    );

    try {
      return await fetch(new URL(path, connectBaseUrl), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sharedSecret}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        const message = error instanceof Error ? error.message : 'backend request timed out';
        throw new McpBackendError(message, 504);
      }
      const message = error instanceof Error ? error.message : 'backend request failed';
      throw new McpBackendError(message, 502);
    } finally {
      clearTimeout(timeoutId);
    }
  };

  const getContext = (): Promise<ContextResponse | null> => {
    contextPromise ??= (async () => {
      const res = await post('/mcp-backend/context', { userId });
      if (res.status === 404) return null;
      if (!res.ok) throw new McpBackendError('context fetch failed', res.status);
      const body = await parseJsonResponse(res, 'context response malformed');
      if (!isContextResponse(body)) {
        throw new McpBackendError('context response malformed', 502);
      }
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
      const body = await parseJsonResponse(res, 'mint response malformed');
      if (!isRecord(body) || typeof body.token !== 'string') {
        throw new McpBackendError('mint response malformed', 502);
      }
      return body.token;
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
