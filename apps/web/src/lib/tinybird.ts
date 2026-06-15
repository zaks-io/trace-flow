import {
  fetchPipe as fetchPipeCore,
  type FetchPipeOptions,
  type PipeParam,
  TinybirdAuthError,
} from '@trace-flow/tinybird-client';

interface TokenEntry {
  token: string;
  expiresAt: number;
}

// Module-level cache keyed by pipe name — survives across renders/components
const tokenCache = new Map<string, TokenEntry>();
const tokenRequests = new Map<string, Promise<string>>();
let tokenCacheEpoch = 0;

const TOKEN_TTL_MS = 9 * 60 * 1000; // 9 min (tokens expire at 10 min)

type GenerateTokenFn = (args: {
  scopes: { type: string; resource: string }[];
  ttl?: number;
}) => Promise<{ token: string }>;

interface FetchTinybirdPipeOptions<T> {
  pipe: string;
  params?: Record<string, PipeParam>;
  ttl?: number;
  /**
   * Receives the full Tinybird response wrapper (`{ data: rows }`) for backward
   * compatibility with existing call sites. Phase 2 of the spans deepening will
   * flip this to receive `rows` directly.
   */
  transform?: (data: unknown) => T;
  schema?: FetchPipeOptions<unknown>['schema'];
  generateToken: GenerateTokenFn;
}

async function getToken(
  pipe: string,
  generateToken: GenerateTokenFn,
  ttl?: number,
): Promise<string> {
  const cached = tokenCache.get(pipe);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  const pending = tokenRequests.get(pipe);
  if (pending) {
    return pending;
  }

  const requestEpoch = tokenCacheEpoch;
  const request = generateToken({
    scopes: [{ type: 'PIPES:READ', resource: pipe }],
    ttl,
  })
    .then((result) => {
      if (requestEpoch === tokenCacheEpoch) {
        tokenCache.set(pipe, {
          token: result.token,
          expiresAt: Date.now() + TOKEN_TTL_MS,
        });
      }

      return result.token;
    })
    .finally(() => {
      if (tokenRequests.get(pipe) === request) {
        tokenRequests.delete(pipe);
      }
    });

  tokenRequests.set(pipe, request);
  return request;
}

function evictToken(pipe: string) {
  tokenCache.delete(pipe);
}

export function clearTokenCache() {
  tokenCacheEpoch++;
  tokenCache.clear();
  tokenRequests.clear();
}

function baseUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8788';
}

async function fetchOnce<T>(token: string, opts: FetchTinybirdPipeOptions<T>): Promise<T> {
  const rows = await fetchPipeCore({
    baseUrl: baseUrl(),
    token,
    pipe: opts.pipe,
    params: opts.params,
    retry: true,
    schema: opts.schema,
  });
  const wrapped = { data: rows };
  if (opts.transform) {
    return opts.transform(wrapped);
  }
  return wrapped as unknown as T;
}

export async function fetchTinybirdPipe<T = unknown>(
  opts: FetchTinybirdPipeOptions<T>,
): Promise<T> {
  try {
    const token = await getToken(opts.pipe, opts.generateToken, opts.ttl);
    return await fetchOnce<T>(token, opts);
  } catch (err) {
    if (err instanceof TinybirdAuthError) {
      // Evict stale token and retry once
      evictToken(opts.pipe);
      const freshToken = await getToken(opts.pipe, opts.generateToken, opts.ttl);
      return await fetchOnce<T>(freshToken, opts);
    }
    throw err;
  }
}

const ONE_MINUTE_MS = 60 * 1000;

/** Snap a ms timestamp to the nearest minute so query keys stay stable across refreshes */
export function snapToMinute(ms: number): number {
  return Math.floor(ms / ONE_MINUTE_MS) * ONE_MINUTE_MS;
}

export const tinybirdKeys = {
  all: ['tinybird'] as const,
  pipe: (pipe: string) => ['tinybird', pipe] as const,
  pipeWithParams: (pipe: string, params: Record<string, unknown> | undefined) =>
    ['tinybird', pipe, params ?? {}] as const,
};
