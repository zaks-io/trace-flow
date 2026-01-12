import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { auth0 } from '@/lib/auth0';

export async function middleware(request: NextRequest) {
  try {
    // Type assertion needed for Next.js 16 compatibility with Auth0 SDK
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = await auth0.middleware(request as any);

    // Proactively refresh for protected routes to persist rotated refresh tokens.
    // Server Components cannot set cookies - middleware must do this.
    const pathname = request.nextUrl.pathname;
    const shouldTouchTokens =
      pathname.startsWith('/app') && !pathname.startsWith('/auth') && !pathname.startsWith('/api');

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
    // Auth0 SDK throws on expired/invalid JWTs instead of treating as "no session"
    // Redirect to login with returnTo for seamless re-authentication
    // See: https://github.com/auth0/nextjs-auth0/issues/2081
    const loginUrl = new URL('/auth/login', request.url);
    loginUrl.searchParams.set('returnTo', `${request.nextUrl.pathname}${request.nextUrl.search}`);
    const response = NextResponse.redirect(loginUrl);

    // Clear auth cookies to prevent redirect loops
    response.cookies.delete('__session');
    // Best-effort delete chunked cookies (Auth0 SDK uses `${name}__${index}`)
    for (let i = 0; i < 20; i++) {
      response.cookies.delete(`__session__${i}`);
    }
    // Clear transaction cookies (Auth0 SDK uses `__txn_` prefix)
    for (const { name } of request.cookies.getAll()) {
      if (name.startsWith('__txn_')) {
        response.cookies.delete(name);
      }
    }
    // Legacy v3 cookie name (Auth0 SDK migrates this)
    response.cookies.delete('appSession');
    // Best-effort legacy chunk format `${name}.${index}`
    for (let i = 0; i < 20; i++) {
      response.cookies.delete(`appSession.${i}`);
    }

    return response;
  }
}

export const config = {
  matcher: [
    // Skip static files and images
    '/((?!_next/static|_next/image|favicon.ico|favicon.svg|logo.svg|robots.txt|sitemap.xml).*)',
  ],
};
