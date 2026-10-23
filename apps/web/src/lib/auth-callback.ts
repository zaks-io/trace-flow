import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';
import type { OnCallbackHook } from '@auth0/nextjs-auth0/types';

// The SDK default answers a failed callback, such as Auth0 refusing a sign-up, with a
// plain-text 500 and reports nothing. Report it and show the auth error page instead.
export const handleAuthCallback: OnCallbackHook = async (error, ctx) => {
  const appBaseUrl = ctx.appBaseUrl ?? process.env.APP_BASE_URL;
  if (!appBaseUrl) throw error ?? new Error('Auth0 callback could not resolve the app base URL');

  const base = new URL(appBaseUrl);
  if (error) {
    Sentry.captureException(error);
    return NextResponse.redirect(new URL('/auth/error', base));
  }
  // The SDK stores returnTo as a path, but a path like //evil.example resolves to
  // another host, so only same-origin targets are followed.
  const target = new URL(ctx.returnTo || '/', base);
  return NextResponse.redirect(target.origin === base.origin ? target : base);
};
