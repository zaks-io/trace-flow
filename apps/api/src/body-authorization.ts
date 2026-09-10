import type { VerifiedBodyAccessToken } from './body-access-token';

export type BodyAuthorizationResult = 'authorized' | 'denied' | 'unavailable';

export async function authorizeBodyAccess(
  env: { CONVEX_SITE_URL: string; BODY_ACCESS_JWT_SECRET: string },
  claims: VerifiedBodyAccessToken,
): Promise<BodyAuthorizationResult> {
  try {
    const response = await fetch(`${env.CONVEX_SITE_URL}/worker/authorize-body-access`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.BODY_ACCESS_JWT_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sub: claims.sub,
        userId: claims.userId,
        orgId: claims.orgId,
      }),
    });
    if (!response.ok) return 'unavailable';
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object' || !('authorized' in body)) return 'unavailable';
    if (body.authorized === true) return 'authorized';
    if (body.authorized === false) return 'denied';
    return 'unavailable';
  } catch {
    return 'unavailable';
  }
}
