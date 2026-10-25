import type { HonoWithConvex } from 'convex-helpers/server/hono';
import type { ActionCtx } from '../_generated/server';
import type { HttpDeps } from './deps';
import { isValidS256Challenge } from './mcpPkce';
import { isLoopbackRedirect } from './redirectUris';
import { getRequestLogger } from './shared';

export function registerCollectorAuthorizeRoutes(
  app: HonoWithConvex<ActionCtx>,
  { oauth }: HttpDeps,
): void {
  // Collector CLI login: start the browser device flow. The CLI opens this URL with a loopback
  // `redirect_uri` and a PKCE `code_challenge`; we sign both into the OAuth state and bounce to
  // Auth0, reusing the exact MCP authorize machinery. The shared callback then redirects to that
  // loopback with a one-time code the CLI redeems at /collector/token. Clients from before PKCE
  // send no challenge and receive the credential in the redirect instead.
  app.get('/collector/authorize', async (c) => {
    const logger = getRequestLogger(c.req.raw, { operation: 'collector_authorize' });

    const url = new URL(c.req.url);
    const redirectUri = url.searchParams.get('redirect_uri');
    const clientState = url.searchParams.get('state') ?? '';
    const codeChallenge = url.searchParams.get('code_challenge');
    if (!redirectUri) {
      return c.json({ error: 'redirect_uri is required' }, 400);
    }
    // Loopback only: the CLI listens on 127.0.0.1, so a non-loopback redirect is an attempt to
    // exfiltrate a freshly minted credential to a third party. Reject it outright.
    if (!isLoopbackRedirect(redirectUri)) {
      logger.warn('convex.collector_authorize_bad_redirect');
      await logger.flush();
      return c.json({ error: 'redirect_uri must be a loopback (127.0.0.1) address' }, 400);
    }

    if (
      codeChallenge !== null &&
      (url.searchParams.get('code_challenge_method') !== 'S256' ||
        !isValidS256Challenge(codeChallenge))
    ) {
      logger.warn('convex.collector_authorize_bad_challenge');
      await logger.flush();
      return c.json({ error: 'code_challenge must be an S256 PKCE challenge' }, 400);
    }

    // Reuse the registered /mcp/callback (Auth0 only allows that path); the `collector:` state tag
    // tells the shared callback to mint a Collector Credential rather than run the MCP auth-code path.
    const callbackUrl = new URL('/mcp/callback', url.origin).toString();
    const state = await oauth.signState({
      clientState: `collector:${clientState}`,
      redirectUri,
      ...(codeChallenge === null ? {} : { codeChallenge, codeChallengeMethod: 'S256' }),
    });
    const auth0Url = oauth.buildAuth0AuthorizeUrl(state, callbackUrl);

    await logger.flush();
    return new Response(null, {
      status: 302,
      headers: { Location: auth0Url, 'Cache-Control': 'no-store' },
    });
  });
}
