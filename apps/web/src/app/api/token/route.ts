import { auth0 } from '@/lib/auth0';
import { clearAuthCookiesFromResponse } from '@/lib/auth-cookies';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { type NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

async function checkTokenRefreshRateLimit(request: NextRequest): Promise<NextResponse | null> {
  try {
    const { env } = await getCloudflareContext({ async: true });
    const limiter = (env as Record<string, unknown>).TOKEN_REFRESH_LIMITER as
      | RateLimitBinding
      | undefined;
    if (!limiter) return null;
    // Only trust `cf-connecting-ip` — Cloudflare injects it. `x-forwarded-for`
    // is client-controlled and lets a caller cycle their rate-limit key.
    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
    const { success } = await limiter.limit({ key: ip });
    if (!success) {
      return NextResponse.json(
        { error: 'Too many requests' },
        { status: 429, headers: { 'Retry-After': '60' } },
      );
    }
    return null;
  } catch {
    // Binding unavailable (dev/SSR) — fail open
    return null;
  }
}

function tryDecodeJwtExp(token: string): number | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf-8')) as unknown;
    if (payload && typeof payload === 'object' && 'exp' in payload) {
      const exp = (payload as { exp: unknown }).exp;
      return typeof exp === 'number' ? exp : null;
    }
    return null;
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  // CSRF protection: validate Origin header
  const origin = request.headers.get('origin');
  const appBaseUrl = process.env.APP_BASE_URL;
  const url = new URL(request.url);
  const forceRefresh = url.searchParams.get('forceRefresh') === '1';

  if (!appBaseUrl) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }
  const expectedOrigin = new URL(appBaseUrl).origin;
  if (origin && origin !== expectedOrigin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const rateLimited = await checkTokenRefreshRateLimit(request);
  if (rateLimited) return rateLimited;

  // Read current session first so we can decide if a refresh-token grant is actually needed.
  // Convex may ask for `forceRefreshToken: true` as part of its normal auth flow; we should
  // only force the refresh grant when our Convex token (ID token) is near expiry.
  const sessionBefore = await auth0.getSession().catch(() => null);
  const idTokenBefore =
    typeof sessionBefore?.tokenSet?.idToken === 'string' ? sessionBefore.tokenSet.idToken : null;

  if (!idTokenBefore) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const idTokenExpBefore = tryDecodeJwtExp(idTokenBefore);
  const nowSec = Math.floor(Date.now() / 1000);
  const idTokenNeedsRefresh = idTokenExpBefore === null ? true : idTokenExpBefore <= nowSec + 60;
  const shouldAttemptRefreshGrant = forceRefresh && idTokenNeedsRefresh;

  try {
    // getAccessToken() triggers automatic refresh when the access token expires.
    // We additionally "force" the refresh-token grant when our Convex token (ID token) is near expiry.
    await auth0.getAccessToken({ refresh: shouldAttemptRefreshGrant });

    // Get the refreshed session with fresh ID token
    const session = await auth0.getSession();

    if (!session?.tokenSet?.idToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const idToken = session.tokenSet.idToken;
    const idTokenExp = tryDecodeJwtExp(idToken) ?? idTokenExpBefore;

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

    if (errorCode === 'failed_to_refresh_token' && causeCode === 'invalid_grant') {
      // If the ID token is still valid, return it instead of forcing a logout.
      // The refresh token in the session is dead — when this ID token expires,
      // the next refresh will fail and trigger a full re-auth.
      if (idTokenExpBefore && idTokenExpBefore > nowSec) {
        console.warn('invalid_grant but ID token still valid — returning stale session token');
        return NextResponse.json({
          token: idTokenBefore,
          expiresAt: idTokenExpBefore,
        });
      }

      // Token also expired — clear Auth0 session cookies so the next
      // navigation can establish a fresh session (often silent via SSO).
      clearAuthCookiesFromResponse(response);
    }

    return response;
  }
}
