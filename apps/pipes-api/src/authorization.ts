export type PipesAuthorization =
  | { kind: 'allowed'; token: string; expiresAt: number }
  | { kind: 'denied' }
  | { kind: 'unavailable' };

export async function authorizePipesQuery(
  env: { CONVEX_SITE_URL: string; PIPES_API_SHARED_SECRET: string },
  grant: string,
  pipe: string,
): Promise<PipesAuthorization> {
  try {
    const response = await fetch(`${env.CONVEX_SITE_URL}/worker/authorize-pipes-query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.PIPES_API_SHARED_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ grant, pipe }),
    });
    if (!response.ok) return { kind: 'unavailable' };
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object' || !('authorized' in body)) {
      return { kind: 'unavailable' };
    }
    if (body.authorized === false) return { kind: 'denied' };
    if (
      body.authorized === true &&
      'token' in body &&
      typeof body.token === 'string' &&
      'expiresAt' in body &&
      typeof body.expiresAt === 'number'
    ) {
      return { kind: 'allowed', token: body.token, expiresAt: body.expiresAt };
    }
    return { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}
