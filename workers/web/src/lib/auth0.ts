import { Auth0Client } from '@auth0/nextjs-auth0/server';

export const auth0 = new Auth0Client({
  appBaseUrl: process.env.APP_BASE_URL,
  httpTimeout: 15000,
  signInReturnToPath: '/app',
  logoutStrategy: 'v2',
  authorizationParameters: {
    scope: 'openid profile email offline_access',
  },
  session: {
    rolling: true,
    absoluteDuration: 60 * 60 * 24 * 30, // 30 days
    inactivityDuration: 60 * 60 * 24 * 7, // 7 days
  },
});

type Session = Awaited<ReturnType<typeof auth0.getSession>>;

/**
 * Wrapper for auth0.getSession() that handles a bug in @auth0/nextjs-auth0 v4.x
 * where expired/invalid JWTs throw instead of returning null.
 *
 * The official docs show getSession() returning null for no session, but since
 * v4.5.1 it throws "Could not verify OIDC token claim" on expired tokens.
 * Auth0 acknowledged this as unintentional (PR #2082) but it persists in v4.14.0.
 *
 * Bug: https://github.com/auth0/nextjs-auth0/issues/2081
 */
export async function getSession(): Promise<Session> {
  try {
    return await auth0.getSession();
  } catch {
    return null;
  }
}
