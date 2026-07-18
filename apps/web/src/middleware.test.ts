import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { auth0 } from '@/lib/auth0';
import { clearAuthCookies } from '@/lib/auth-cookies';
import { middleware } from './middleware';

vi.mock('@trace-flow/utils', () => ({
  applySecurityHeaders: vi.fn(),
}));

vi.mock('@/lib/auth0', () => ({
  auth0: {
    middleware: vi.fn(),
    getSession: vi.fn(),
    getAccessToken: vi.fn(),
  },
}));

vi.mock('@/lib/auth-cookies', () => ({
  clearAuthCookies: vi.fn(),
}));

vi.mock('@/lib/csp', () => ({
  buildCsp: vi.fn(() => "default-src 'self'"),
  buildSentryReportUri: vi.fn(() => null),
  CSP_HEADER_NAME: 'content-security-policy',
  readOrigin: vi.fn(() => null),
}));

const mockedAuth0 = vi.mocked(auth0);
const mockedClearAuthCookies = vi.mocked(clearAuthCookies);

function request(path: string): NextRequest {
  return new NextRequest(`https://trace-flow.dev${path}`);
}

function validIdToken(): string {
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 300 }))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `header.${payload}.signature`;
}

describe('protected app middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedAuth0.middleware.mockResolvedValue(NextResponse.next());
    mockedAuth0.getAccessToken.mockResolvedValue({ token: 'access-token', expiresAt: 1 });
  });

  it('redirects an unauthenticated app request before rendering', async () => {
    mockedAuth0.getSession.mockResolvedValue(null);
    const req = request('/app/traces?range=24h');

    const response = await middleware(req);

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://trace-flow.dev/auth/login?returnTo=%2Fapp%2Ftraces%3Frange%3D24h',
    );
    expect(mockedAuth0.getAccessToken).not.toHaveBeenCalled();
    expect(mockedClearAuthCookies).toHaveBeenCalledWith(req, response);
  });

  it('redirects an expired Convex ID token instead of rendering with it', async () => {
    mockedAuth0.getSession.mockResolvedValue({
      tokenSet: { idToken: 'header.eyJleHAiOjF9.signature' },
    } as never);

    const response = await middleware(request('/app'));

    expect(response.status).toBe(307);
    expect(mockedAuth0.getAccessToken).not.toHaveBeenCalled();
    expect(mockedClearAuthCookies).toHaveBeenCalledOnce();
  });

  it('clears a session that Auth0 cannot verify', async () => {
    mockedAuth0.getSession.mockRejectedValue(new Error('Could not verify OIDC token claim'));

    const response = await middleware(request('/app'));

    expect(response.status).toBe(307);
    expect(mockedClearAuthCookies).toHaveBeenCalledOnce();
  });

  it('continues authenticated requests and persists token refreshes', async () => {
    mockedAuth0.getSession.mockResolvedValue({
      tokenSet: { idToken: validIdToken() },
    } as never);
    const req = request('/app');

    const response = await middleware(req);

    expect(response.status).toBe(200);
    expect(mockedAuth0.getAccessToken).toHaveBeenCalledWith(req, response);
    expect(mockedClearAuthCookies).not.toHaveBeenCalled();
  });
});
