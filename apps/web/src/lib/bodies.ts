import { formatBodyForDisplay, type FormattedBody } from '@trace-flow/utils';
import type { StoredBodiesPayload } from '@trace-flow/types';

interface BodyAccessTokenEntry {
  token: string;
  expiresAtMs: number;
}

interface FormattedStoredBodies {
  requestBody: FormattedBody | null;
  responseBody: FormattedBody | null;
  truncated: boolean;
}

type IssueBodyTokenFn = (args: {
  requestId: string;
}) => Promise<{ token: string; expiresAt: number }>;

const BODY_TOKEN_REFRESH_WINDOW_MS = 5 * 1000;
const MAX_BODY_TOKEN_CACHE_ENTRIES = 100;

const bodyTokenCache = new Map<string, BodyAccessTokenEntry>();
const bodyTokenRequests = new Map<string, Promise<string>>();
let bodyTokenCacheEpoch = 0;

function isUsableBodyToken(entry: BodyAccessTokenEntry): boolean {
  return entry.expiresAtMs - BODY_TOKEN_REFRESH_WINDOW_MS > Date.now();
}

function pruneBodyTokenCache() {
  for (const [requestId, entry] of bodyTokenCache) {
    if (!isUsableBodyToken(entry)) {
      bodyTokenCache.delete(requestId);
    }
  }

  while (bodyTokenCache.size > MAX_BODY_TOKEN_CACHE_ENTRIES) {
    const oldestRequestId = bodyTokenCache.keys().next().value;
    if (oldestRequestId === undefined) return;
    bodyTokenCache.delete(oldestRequestId);
  }
}

export function clearBodyAccessTokenCache() {
  bodyTokenCacheEpoch++;
  bodyTokenCache.clear();
  bodyTokenRequests.clear();
}

export async function getBodyAccessToken(
  requestId: string,
  issueBodyToken: IssueBodyTokenFn,
): Promise<string> {
  const cached = bodyTokenCache.get(requestId);
  if (cached && isUsableBodyToken(cached)) {
    return cached.token;
  }

  const pending = bodyTokenRequests.get(requestId);
  if (pending) {
    return pending;
  }

  const requestEpoch = bodyTokenCacheEpoch;
  const request = issueBodyToken({ requestId })
    .then((result) => {
      const entry = {
        token: result.token,
        expiresAtMs: result.expiresAt * 1000,
      };

      if (requestEpoch === bodyTokenCacheEpoch && isUsableBodyToken(entry)) {
        bodyTokenCache.delete(requestId);
        bodyTokenCache.set(requestId, entry);
        pruneBodyTokenCache();
      }

      return result.token;
    })
    .finally(() => {
      if (bodyTokenRequests.get(requestId) === request) {
        bodyTokenRequests.delete(requestId);
      }
    });

  bodyTokenRequests.set(requestId, request);
  return request;
}

export async function fetchStoredBodies(
  requestId: string,
  token: string,
  signal: AbortSignal,
): Promise<StoredBodiesPayload | null> {
  const apiUrl =
    process.env.NEXT_PUBLIC_RAW_API_URL ??
    process.env.NEXT_PUBLIC_API_URL ??
    'http://localhost:8788';

  const res = await fetch(`${apiUrl}/bodies/${requestId}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });

  if (!res.ok) {
    if (res.status === 403 || res.status === 404 || res.status === 410) return null;

    const errorData = (await res.json().catch(() => null)) as {
      error?: string;
      message?: string;
    } | null;
    throw new Error(
      errorData?.message ?? errorData?.error ?? `HTTP ${res.status}: ${res.statusText}`,
    );
  }

  const data: unknown = await res.json();

  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('Invalid body payload: expected an object');
  }

  return data as StoredBodiesPayload;
}

export function formatStoredBodiesForDisplay(
  payload: StoredBodiesPayload | null,
): FormattedStoredBodies {
  return {
    requestBody: formatBodyForDisplay(payload?.requestBody ?? null),
    responseBody: formatBodyForDisplay(payload?.responseBody ?? null),
    truncated: payload?.truncated === true,
  };
}
