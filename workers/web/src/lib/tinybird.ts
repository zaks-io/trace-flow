class TinybirdAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TinybirdAuthError';
  }
}

interface TokenEntry {
  token: string;
  expiresAt: number;
}

// Module-level cache keyed by pipe name — survives across renders/components
const tokenCache = new Map<string, TokenEntry>();

const TOKEN_TTL_MS = 9 * 60 * 1000; // 9 min (tokens expire at 10 min)

type GenerateTokenFn = (args: {
  scopes: { type: string; resource: string }[];
  ttl?: number;
}) => Promise<{ token: string }>;

interface FetchTinybirdPipeOptions<T> {
  pipe: string;
  params?: Record<string, string | number | boolean | undefined>;
  ttl?: number;
  transform?: (data: unknown) => T;
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

  const result = await generateToken({
    scopes: [{ type: 'PIPES:READ', resource: pipe }],
    ttl,
  });

  tokenCache.set(pipe, {
    token: result.token,
    expiresAt: Date.now() + TOKEN_TTL_MS,
  });

  return result.token;
}

function evictToken(pipe: string) {
  tokenCache.delete(pipe);
}

export function clearTokenCache() {
  tokenCache.clear();
}

async function fetchWithToken<T>(
  token: string,
  pipe: string,
  params?: Record<string, string | number | boolean | undefined>,
  transform?: (data: unknown) => T,
): Promise<T> {
  const apiUrl = process.env.NEXT_PUBLIC_TINYBIRD_API_URL ?? 'https://api.tinybird.co';
  const url = new URL(`${apiUrl}/v0/pipes/${pipe}.json`);

  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const errorText = await response.text();
    const message = `Tinybird pipe query failed: ${response.status} - ${errorText}`;
    if (response.status === 403) {
      throw new TinybirdAuthError(message);
    }
    throw new Error(message);
  }

  const result = await response.json();
  return transform ? transform(result) : result;
}

export async function fetchTinybirdPipe<T = unknown>(
  opts: FetchTinybirdPipeOptions<T>,
): Promise<T> {
  const { pipe, params, ttl, transform, generateToken } = opts;

  try {
    const token = await getToken(pipe, generateToken, ttl);
    return await fetchWithToken<T>(token, pipe, params, transform);
  } catch (err) {
    if (err instanceof TinybirdAuthError) {
      // Evict stale token and retry once
      evictToken(pipe);
      const freshToken = await getToken(pipe, generateToken, ttl);
      return await fetchWithToken<T>(freshToken, pipe, params, transform);
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
