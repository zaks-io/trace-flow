import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { applySecurityHeaders } from '@trace-flow/utils';
import { auth0 } from '@/lib/auth0';
import { clearAuthCookies } from '@/lib/auth-cookies';

const PROD_CONNECT_SRC = [
  "'self'",
  'https://api.trace-flow.dev',
  'https://*.convex.cloud',
  'wss://*.convex.cloud',
  'https://auth0.zaks.io',
  'https://*.ingest.sentry.io',
  'https://*.ingest.us.sentry.io',
  'https://*.launchdarkly.com',
  'https://clientstream.launchdarkly.com',
  'https://events.launchdarkly.com',
  'https://app.launchdarkly.com',
];

// Localhost origins are needed in dev for HMR websockets, dev server fetches,
// and the local API/Convex/Tinybird workers running on 127.0.0.1/localhost ports.
const DEV_CONNECT_SRC = ['http://localhost:*', 'ws://localhost:*', 'http://127.0.0.1:*'];

// Turn a Sentry browser DSN into the CSP `report-uri` endpoint.
// DSN:    https://{key}@{host}/{projectId}
// Report: https://{host}/api/{projectId}/security/?sentry_key={key}
function buildSentryReportUri(dsn: string | undefined): string | null {
  if (!dsn) return null;
  try {
    const url = new URL(dsn);
    const projectId = url.pathname.replace(/^\//, '');
    const key = url.username;
    if (!projectId || !key) return null;
    return `${url.protocol}//${url.host}/api/${projectId}/security/?sentry_key=${key}`;
  } catch {
    return null;
  }
}

function buildCsp(nonce: string, isDev: boolean, reportUri: string | null): string {
  const connectSrc = isDev ? [...PROD_CONNECT_SRC, ...DEV_CONNECT_SRC] : PROD_CONNECT_SRC;

  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    `connect-src ${connectSrc.join(' ')}`,
    "worker-src 'self' blob:",
    "frame-src 'self' https://auth0.zaks.io",
    "frame-ancestors 'none'",
    "form-action 'self' https://auth0.zaks.io",
    "base-uri 'self'",
    "object-src 'none'",
    'upgrade-insecure-requests',
  ];

  if (reportUri) directives.push(`report-uri ${reportUri}`);

  return directives.join('; ');
}

// Rollout is Report-Only first. Flip to 'Content-Security-Policy' to enforce.
const CSP_HEADER_NAME = 'Content-Security-Policy-Report-Only';

function applyResponseSecurityHeaders(response: NextResponse, csp: string): void {
  applySecurityHeaders(response.headers);
  response.headers.set(CSP_HEADER_NAME, csp);
}

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  const nonce = btoa(crypto.randomUUID());
  const reportUri = buildSentryReportUri(process.env.NEXT_PUBLIC_SENTRY_DSN);
  const csp = buildCsp(nonce, process.env.NODE_ENV === 'development', reportUri);

  // Mutate the request Headers so downstream Server Components can read the
  // nonce via `headers().get('x-nonce')` and apply it to inline scripts.
  request.headers.set('x-nonce', nonce);

  const isPublicMarkdownPath =
    pathname === '/llms.txt' ||
    pathname === '/agents.md' ||
    (pathname.startsWith('/docs/') && pathname.endsWith('.md'));

  if (isPublicMarkdownPath) {
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
      const session = await auth0.getSession(request as any).catch(() => null);
      if (session) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await auth0.getAccessToken(request as any, response).catch(() => undefined);
      }
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
    const loginUrl = new URL('/auth/login', request.url);
    loginUrl.searchParams.set('returnTo', `${request.nextUrl.pathname}${request.nextUrl.search}`);
    const response = NextResponse.redirect(loginUrl);
    clearAuthCookies(request, response);
    applyResponseSecurityHeaders(response, csp);
    return response;
  }
}

export const config = {
  matcher: [
    // Skip static files and images
    '/((?!_next/static|_next/image|favicon.ico|favicon.svg|logo.svg|robots.txt|sitemap.xml).*)',
  ],
};
