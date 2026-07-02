import {
  fetchPipe as fetchPipeCore,
  type FetchPipeOptions,
  type PipeParam,
  TinybirdAuthError,
} from '@trace-flow/tinybird-client';

interface TokenEntry {
  token: string;
  expiresAtMs: number;
}

// Module-level cache survives across renders/components.
let tokenCache: TokenEntry | null = null;
let tokenRequest: Promise<string> | null = null;
let tokenCacheEpoch = 0;

const TOKEN_REFRESH_WINDOW_MS = 30 * 1000;

type GenerateWebReadTokenFn = () => Promise<{ token: string; expiresAt: number }>;

interface FetchTinybirdPipeOptions<T> {
  pipe: string;
  params?: Record<string, PipeParam>;
  /**
   * Receives the full Tinybird response wrapper (`{ data: rows }`) for backward
   * compatibility with existing call sites. Phase 2 of the spans deepening will
   * flip this to receive `rows` directly.
   */
  transform?: (data: unknown) => T;
  schema?: FetchPipeOptions<unknown>['schema'];
  generateWebReadToken: GenerateWebReadTokenFn;
}

function isUsableToken(entry: TokenEntry): boolean {
  return entry.expiresAtMs - TOKEN_REFRESH_WINDOW_MS > Date.now();
}

async function getToken(generateWebReadToken: GenerateWebReadTokenFn): Promise<string> {
  const cached = tokenCache;
  if (cached && isUsableToken(cached)) {
    return cached.token;
  }

  if (tokenRequest) {
    return tokenRequest;
  }

  const requestEpoch = tokenCacheEpoch;
  const request = generateWebReadToken()
    .then((result) => {
      const entry = {
        token: result.token,
        expiresAtMs: result.expiresAt * 1000,
      };

      if (requestEpoch === tokenCacheEpoch && isUsableToken(entry)) {
        tokenCache = entry;
      }

      return result.token;
    })
    .finally(() => {
      if (tokenRequest === request) {
        tokenRequest = null;
      }
    });

  tokenRequest = request;
  return request;
}

function evictToken() {
  tokenCache = null;
}

export function clearTokenCache() {
  tokenCacheEpoch++;
  tokenCache = null;
  tokenRequest = null;
}

function baseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_PIPES_API_URL ??
    process.env.NEXT_PUBLIC_API_URL ??
    'http://localhost:8788'
  );
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
    const token = await getToken(opts.generateWebReadToken);
    return await fetchOnce<T>(token, opts);
  } catch (err) {
    if (err instanceof TinybirdAuthError) {
      // Evict stale token and retry once
      evictToken();
      const freshToken = await getToken(opts.generateWebReadToken);
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
