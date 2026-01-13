import 'server-only';
import { cache } from 'react';
import { auth0 } from './auth0';

export const getConvexAuthToken = cache(async (): Promise<string | null> => {
  try {
    await auth0.getAccessToken();
    const session = await auth0.getSession();
    if (!session?.tokenSet?.idToken) return null;
    const expiresAt = session.tokenSet.expiresAt;
    if (expiresAt && expiresAt * 1000 <= Date.now()) return null;
    return session.tokenSet.idToken;
  } catch {
    return null;
  }
});
