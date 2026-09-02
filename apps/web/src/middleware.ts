import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { applySecurityHeaders } from '@trace-flow/utils';
import { API_CATALOG_PATH } from '@/lib/api-catalog';
import { auth0 } from '@/lib/auth0';
import { clearAuthCookies } from '@/lib/auth-cookies';
import { buildCsp, buildSentryReportUri, CSP_HEADER_NAME, readOrigin } from '@/lib/csp';
import { isConvexTokenUsable } from '@/lib/convex-token';

function applyResponseSecurityHeaders(response: NextResponse, csp: string): void {
  applySecurityHeaders(response.headers);
  response.headers.set(CSP_HEADER_NAME, csp);
}

function redirectToLogin(request: NextRequest, csp: string): NextResponse {
  const loginUrl = new URL('/auth/login', request.url);
  loginUrl.searchParams.set('returnTo', `${request.nextUrl.pathname}${request.nextUrl.search}`);
  const response = NextResponse.redirect(loginUrl);
  clearAuthCookies(request, response);
  applyResponseSecurityHeaders(response, csp);
  return response;
}

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  const nonce = btoa(crypto.randomUUID());
  const reportUri = buildSentryReportUri(process.env.NEXT_PUBLIC_SENTRY_DSN);
  const csp = buildCsp(nonce, process.env.NODE_ENV === 'development', reportUri, [
    readOrigin(process.env.NEXT_PUBLIC_PIPES_API_URL) ?? '',
    readOrigin(process.env.NEXT_PUBLIC_RAW_API_URL) ?? '',
    readOrigin(process.env.NEXT_PUBLIC_API_URL) ?? '',
  ]);

  // Mutate the request Headers so downstream Server Components can read the
  // nonce via `headers().get('x-nonce')` and apply it to inline scripts.
  request.headers.set('x-nonce', nonce);

  const isPublicMachineReadablePath =
    pathname === '/llms.txt' ||
    pathname === '/agents.md' ||
    pathname === '/auth.md' ||
    pathname === API_CATALOG_PATH ||
    pathname === '/.well-known/oauth-protected-resource' ||
    pathname === '/.well-known/mcp/server-card.json' ||
    pathname === '/.well-known/ai-catalog.json' ||
    pathname.startsWith('/.well-known/agent-skills/') ||
    (pathname.startsWith('/docs/') && pathname.endsWith('.md'));

  if (isPublicMachineReadablePath) {
    const response = NextResponse.next();
    applyResponseSecurityHeaders(response, csp);
    return response;
  }

  try {
    // Type assertion needed for Next.js 16 compatibility with Auth0 SDK
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = await auth0.middleware(request as any);

    // Proactively refresh for protected routes to persist rotated refresh tokens.
    // Server Components cannot set cookies - middleware must do this.
    const shouldTouchTokens = pathname.startsWith('/app');

    if (shouldTouchTokens) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const session = await auth0.getSession(request as any);
      if (!isConvexTokenUsable(session?.tokenSet?.idToken)) {
        return redirectToLogin(request, csp);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await auth0.getAccessToken(request as any, response).catch(() => undefined);
    }

    applyResponseSecurityHeaders(response, csp);
    return response;
  } catch {
    // Auth route error recovery: throw → clear cookies → /auth/login?cleared=1
    // If login still throws with cleared flag, bail to static /auth/error page.
    if (pathname.startsWith('/auth/')) {
      // /auth/error is a static page — bypass auth entirely if it somehow throws
      if (pathname === '/auth/error') {
        const response = NextResponse.next();
        applyResponseSecurityHeaders(response, csp);
        return response;
      }
      // Guard against infinite loops if /auth/login itself keeps throwing
      if (request.nextUrl.searchParams.has('cleared')) {
        const response = NextResponse.redirect(new URL('/auth/error', request.url));
        applyResponseSecurityHeaders(response, csp);
        return response;
      }
      const loginUrl = new URL('/auth/login', request.url);
      loginUrl.searchParams.set('cleared', '1');
      const response = NextResponse.redirect(loginUrl);
      clearAuthCookies(request, response);
      applyResponseSecurityHeaders(response, csp);
      return response;
    }

    // Auth0 SDK throws on expired/invalid JWTs instead of treating as "no session"
    // Redirect to login with returnTo for seamless re-authentication
    // See: https://github.com/auth0/nextjs-auth0/issues/2081
    return redirectToLogin(request, csp);
  }
}

export const config = {
  matcher: [
    // Skip static files and images
    '/((?!_next/static|_next/image|favicon.ico|favicon.svg|logo.svg|robots.txt|sitemap.xml|.well-known/security.txt).*)',
  ],
};
