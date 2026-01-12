import { auth0 } from '@/lib/auth0';
import { type NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

interface JwtClaims {
  exp: number | null;
  iat: number | null;
  iss: string | null;
  aud: string | string[] | null;
}

interface BufferConstructorLike {
  from: (input: string, encoding: 'base64') => { toString: (encoding: 'utf-8') => string };
}

function getGlobalBufferConstructor(): BufferConstructorLike | null {
  const maybeBuffer = (globalThis as unknown as { Buffer?: unknown }).Buffer;
  if (
    typeof maybeBuffer === 'function' &&
    'from' in maybeBuffer &&
    typeof (maybeBuffer as BufferConstructorLike).from === 'function'
  ) {
    return maybeBuffer as BufferConstructorLike;
  }
  return null;
}

function decodeBase64Url(base64Url: string): string | null {
  const base64 = base64Url
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(base64Url.length / 4) * 4, '=');

  try {
    const atobFn = (globalThis as unknown as { atob?: ((data: string) => string) | undefined })
      .atob;
    if (typeof atobFn === 'function') {
      return atobFn(base64);
    }

    const bufferCtor = getGlobalBufferConstructor();
    if (bufferCtor) {
      return bufferCtor.from(base64, 'base64').toString('utf-8');
    }

    return null;
  } catch {
    return null;
  }
}

function decodeJwtClaims(token: string): JwtClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }

  const json = decodeBase64Url(parts[1] ?? '');
  if (!json) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }

  const obj = parsed as Record<string, unknown>;
  const exp = typeof obj.exp === 'number' ? obj.exp : null;
  const iat = typeof obj.iat === 'number' ? obj.iat : null;
  const iss = typeof obj.iss === 'string' ? obj.iss : null;

  let aud: string | string[] | null = null;
  if (typeof obj.aud === 'string') {
    aud = obj.aud;
  } else if (Array.isArray(obj.aud) && obj.aud.every((v) => typeof v === 'string')) {
    aud = obj.aud;
  }

  return { exp, iat, iss, aud };
}

export async function GET(request: NextRequest) {
  // CSRF protection: validate Origin header
  const origin = request.headers.get('origin');
  const appBaseUrl = process.env.APP_BASE_URL;
  const url = new URL(request.url);
  const forceRefresh = url.searchParams.get('forceRefresh') === '1';

  if (appBaseUrl) {
    const expectedOrigin = new URL(appBaseUrl).origin;
    if (origin && origin !== expectedOrigin) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  }

  try {
    // Read current session first so we can decide if a refresh-token grant is actually needed.
    // Convex may ask for `forceRefreshToken: true` as part of its normal auth flow; we should
    // only force the refresh grant when our Convex token (ID token) is near expiry.
    const sessionBefore = await auth0.getSession().catch(() => null);
    const idTokenBefore =
      typeof sessionBefore?.tokenSet?.idToken === 'string' ? sessionBefore.tokenSet.idToken : null;

    if (!idTokenBefore) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const claimsBefore = decodeJwtClaims(idTokenBefore);
    const idTokenExpBefore = claimsBefore?.exp ?? null;
    const nowSec = Math.floor(Date.now() / 1000);
    const idTokenNeedsRefresh = idTokenExpBefore === null ? true : idTokenExpBefore <= nowSec + 60;
    const shouldAttemptRefreshGrant = forceRefresh && idTokenNeedsRefresh;

    // getAccessToken() triggers automatic refresh when the access token expires.
    // We additionally "force" the refresh-token grant when our Convex token (ID token) is near expiry.
    await auth0.getAccessToken({ refresh: shouldAttemptRefreshGrant });

    // Get the refreshed session with fresh ID token
    const session = await auth0.getSession();

    if (!session?.tokenSet?.idToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const idToken = session.tokenSet.idToken;
    const claims = decodeJwtClaims(idToken);
    const idTokenExp = claims?.exp ?? idTokenExpBefore;

    // Validate token isn't already expired before returning
    // Auth0 v4 SDK has bugs where getSession() may return stale tokens
    // See: https://github.com/auth0/nextjs-auth0/issues/2081
    if (idTokenExp && idTokenExp <= nowSec) {
      console.error('ID token expired after getAccessToken() - Auth0 SDK bug?');
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    return NextResponse.json({
      token: idToken,
      expiresAt: idTokenExp ?? session.tokenSet.expiresAt,
    });
  } catch (error: unknown) {
    const response = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const errorObj =
      typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : null;
    const errorCode = typeof errorObj?.code === 'string' ? errorObj.code : null;

    const cause = errorObj?.cause;
    const causeObj =
      typeof cause === 'object' && cause !== null ? (cause as Record<string, unknown>) : null;
    const causeCode = typeof causeObj?.code === 'string' ? causeObj.code : null;

    // If the refresh token is invalid, clear Auth0 session cookies so the next
    // navigation can establish a fresh session (often silent via SSO).
    if (errorCode === 'failed_to_refresh_token' && causeCode === 'invalid_grant') {
      response.cookies.delete('__session');
      // Best-effort delete chunked cookies (Auth0 SDK uses `${name}__${index}`)
      for (let i = 0; i < 20; i++) {
        response.cookies.delete(`__session__${i}`);
      }
      // Legacy v3 cookie name (Auth0 SDK migrates this)
      response.cookies.delete('appSession');
      // Best-effort legacy chunk format `${name}.${index}`
      for (let i = 0; i < 20; i++) {
        response.cookies.delete(`appSession.${i}`);
      }
    }

    // Token refresh failed - user needs to re-authenticate
    return response;
  }
}
