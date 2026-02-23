import { getSession } from './auth0';

export class ConvexTokenError extends Error {
  constructor() {
    super('No Convex token available');
    this.name = 'ConvexTokenError';
  }
}

type Session = Awaited<ReturnType<typeof getSession>>;

/**
 * Extracts the ID token from the Auth0 session for use with Convex preloadQuery.
 * Accepts an optional pre-fetched session to avoid redundant getSession() calls.
 * Throws ConvexTokenError if no session/token exists.
 */
export async function getConvexToken(session?: Session): Promise<string> {
  const resolved = session ?? (await getSession());
  const token = resolved?.tokenSet?.idToken;
  if (!token) {
    throw new ConvexTokenError();
  }
  return token;
}
