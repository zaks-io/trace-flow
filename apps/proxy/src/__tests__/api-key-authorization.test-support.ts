import { env } from 'cloudflare:test';
import { vi } from 'vitest';

interface UpstreamMatcher {
  method: string;
  origin: string;
  pathname: string;
}

export async function authorizeApiKeyRequest(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.origin !== 'https://convex.test' || url.pathname !== '/worker/authorize-api-key') {
    return null;
  }

  const body: unknown = await request.json();
  if (!body || typeof body !== 'object' || !('key' in body) || typeof body.key !== 'string') {
    throw new Error('authorize API key request is malformed');
  }

  const raw = await env.API_KEYS.get(body.key);
  if (!raw) return Response.json({ authorized: false, reason: 'invalid' });

  const keyData = JSON.parse(raw) as { expiresAt: number; createdAt?: number; orgId?: string };
  if (keyData.expiresAt <= Date.now()) {
    return Response.json({ authorized: false, reason: 'expired' });
  }

  return Response.json({
    authorized: true,
    expiresAt: keyData.expiresAt,
    createdAt: keyData.createdAt ?? 0,
    orgId: keyData.orgId ?? 'org-test-123',
  });
}

export function mockUpstream(
  matcher: UpstreamMatcher,
  status: number,
  body: BodyInit,
  responseInit?: ResponseInit,
): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const authorization = await authorizeApiKeyRequest(request.clone());
    if (authorization) return authorization;

    const url = new URL(request.url);
    if (
      request.method === matcher.method &&
      url.origin === matcher.origin &&
      url.pathname === matcher.pathname
    ) {
      await request.arrayBuffer();
      return new Response(body, { status, ...responseInit });
    }

    throw new Error(`unexpected fetch: ${request.method} ${request.url}`);
  });
}
