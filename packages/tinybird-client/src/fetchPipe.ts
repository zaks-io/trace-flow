import { TinybirdAuthError, TinybirdQueryError } from './errors';

export type PipeParam = string | number | boolean | undefined;

export interface FetchPipeOptions<T = unknown> {
  baseUrl: string;
  token: string;
  pipe: string;
  params?: Record<string, PipeParam>;
  /** When true (default), a 403 response throws TinybirdAuthError and caller can retry with a fresh token. */
  retry?: boolean;
  /** Optional zod-style validator. When present, each row in `data` is parsed. */
  schema?: { parse(value: unknown): T };
}

interface PipeResponse {
  data?: unknown[];
}

function buildPipeUrl(baseUrl: string, pipe: string, params?: Record<string, PipeParam>): URL {
  const url = new URL(`${baseUrl}/v0/pipes/${pipe}.json`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url;
}

async function fetchOnce<T>(opts: FetchPipeOptions<T>): Promise<T[]> {
  const url = buildPipeUrl(opts.baseUrl, opts.pipe, opts.params);

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: { Authorization: `Bearer ${opts.token}` },
  });

  if (!response.ok) {
    const errorText = await response.text();
    const message = `Tinybird pipe ${opts.pipe} failed: ${response.status} - ${errorText}`;
    if (response.status === 403) {
      throw new TinybirdAuthError(message);
    }
    throw new TinybirdQueryError(message, response.status);
  }

  const body: PipeResponse = await response.json();
  const rows = body.data ?? [];
  const schema = opts.schema;
  if (schema) {
    return rows.map((row) => schema.parse(row));
  }
  return rows as T[];
}

/**
 * Bearer-token fetch against a Tinybird Pipe endpoint.
 *
 * Token minting is intentionally NOT handled here — admin secrets live in Convex.
 * Callers obtain a JWT (web via `useAction(api.integrations.tinybird.generateWebReadToken)`,
 * MCP via `ctx.runAction(internal.integrations.tinybird.generateTokenInternal)`),
 * then pass it in.
 *
 * `retry: true` (default) surfaces 403 as TinybirdAuthError so callers with a token
 * cache can evict and call again. `retry: false` collapses 403 into TinybirdQueryError.
 */
export async function fetchPipe<T = unknown>(opts: FetchPipeOptions<T>): Promise<T[]> {
  if (opts.retry === false) {
    try {
      return await fetchOnce(opts);
    } catch (err) {
      if (err instanceof TinybirdAuthError) {
        throw new TinybirdQueryError(err.message, 403);
      }
      throw err;
    }
  }
  return fetchOnce(opts);
}
