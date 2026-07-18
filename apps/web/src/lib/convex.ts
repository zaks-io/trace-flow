import { redirect } from 'next/navigation';
import { getSession } from './auth0';
import { isConvexTokenUsable } from './convex-token';

type Session = Awaited<ReturnType<typeof getSession>>;

/**
 * Extracts the ID token from the Auth0 session for use with Convex preloadQuery.
 * Accepts an optional pre-fetched session to avoid redundant getSession() calls.
 * Redirects to login if no usable session token exists.
 */
export async function getConvexToken(session?: Session): Promise<string> {
  const resolved = session ?? (await getSession());
  const token = resolved?.tokenSet?.idToken;
  if (!token || !isConvexTokenUsable(token)) {
    redirect('/auth/login?returnTo=/app');
  }
  return token;
}
