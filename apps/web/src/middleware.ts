import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { auth0 } from '@/lib/auth0';
import { clearAuthCookies } from '@/lib/auth-cookies';

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  const isPublicMarkdownPath =
    pathname === '/llms.txt' ||
    pathname === '/agents.md' ||
    (pathname.startsWith('/docs/') && pathname.endsWith('.md'));

  if (isPublicMarkdownPath) {
    return NextResponse.next();
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

    return response;
  } catch {
    const pathname = request.nextUrl.pathname;

    // Auth route error recovery: throw → clear cookies → /auth/login?cleared=1
    // If login still throws with cleared flag, bail to static /auth/error page.
    if (pathname.startsWith('/auth/')) {
      // /auth/error is a static page — bypass auth entirely if it somehow throws
      if (pathname === '/auth/error') {
        return NextResponse.next();
      }
      // Guard against infinite loops if /auth/login itself keeps throwing
      if (request.nextUrl.searchParams.has('cleared')) {
        return NextResponse.redirect(new URL('/auth/error', request.url));
      }
      const loginUrl = new URL('/auth/login', request.url);
      loginUrl.searchParams.set('cleared', '1');
      const response = NextResponse.redirect(loginUrl);
      clearAuthCookies(request, response);
      return response;
    }

    // Auth0 SDK throws on expired/invalid JWTs instead of treating as "no session"
    // Redirect to login with returnTo for seamless re-authentication
    // See: https://github.com/auth0/nextjs-auth0/issues/2081
    const loginUrl = new URL('/auth/login', request.url);
    loginUrl.searchParams.set('returnTo', `${request.nextUrl.pathname}${request.nextUrl.search}`);
    const response = NextResponse.redirect(loginUrl);
    clearAuthCookies(request, response);
    return response;
  }
}

export const config = {
  matcher: [
    // Skip static files and images
    '/((?!_next/static|_next/image|favicon.ico|favicon.svg|logo.svg|robots.txt|sitemap.xml).*)',
  ],
};
