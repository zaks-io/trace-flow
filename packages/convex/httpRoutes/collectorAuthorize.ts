import type { HonoWithConvex } from 'convex-helpers/server/hono';
import { getCookie } from 'hono/cookie';
import type { ActionCtx } from '../_generated/server';
import { COLLECTOR_CONSENT_COOKIE, serializeCollectorConsentCookie } from './consentCookies';
import type { HttpDeps } from './deps';
import { collectorConsentMatches, renderCollectorConsentPage } from './collectorPages';
import { formPageHeaders, redirectPage } from './htmlPage';
import { isValidS256Challenge } from './mcpPkce';
import { isLoopbackRedirect, OUT_OF_BAND_REDIRECT } from './redirectUris';
import { getRequestLogger } from './shared';

export function registerCollectorAuthorizeRoutes(
  app: HonoWithConvex<ActionCtx>,
  { oauth }: HttpDeps,
): void {
  // Collector CLI login: start the browser sign-in. The Collector opens this URL with a loopback
  // `redirect_uri` (or the out-of-band URN when the browser is elsewhere) and a PKCE
  // `code_challenge`. The user first approves the connection on a consent page bound to this
  // browser, then we sign the request into the OAuth state and bounce to Auth0, reusing the MCP
  // authorize machinery. The shared callback hands back a one-time code the Collector redeems at
  // /collector/token. Clients from before PKCE send no challenge and receive the credential in the
  // loopback redirect instead.
  app.get('/collector/authorize', async (c) => {
    const logger = getRequestLogger(c.req.raw, { operation: 'collector_authorize' });

    const url = new URL(c.req.url);
    const redirectUri = url.searchParams.get('redirect_uri');
    const clientState = url.searchParams.get('state') ?? '';
    const codeChallenge = url.searchParams.get('code_challenge') ?? undefined;
    if (!redirectUri) {
      return c.json({ error: 'redirect_uri is required' }, 400);
    }

    if (
      codeChallenge !== undefined &&
      (url.searchParams.get('code_challenge_method') !== 'S256' ||
        !isValidS256Challenge(codeChallenge))
    ) {
      logger.warn('convex.collector_authorize_bad_challenge');
      await logger.flush();
      return c.json({ error: 'code_challenge must be an S256 PKCE challenge' }, 400);
    }

    // Loopback or out-of-band only, so the result never travels to a third party. Out-of-band
    // shows the code on a page instead of redirecting, which only PKCE makes safe to display.
    const outOfBand = redirectUri === OUT_OF_BAND_REDIRECT;
    if (outOfBand ? codeChallenge === undefined : !isLoopbackRedirect(redirectUri)) {
      logger.warn('convex.collector_authorize_bad_redirect', { out_of_band: outOfBand });
      await logger.flush();
      return c.json(
        {
          error: outOfBand
            ? 'An out-of-band redirect_uri requires a PKCE code_challenge'
            : 'redirect_uri must be a loopback (127.0.0.1) address',
        },
        400,
      );
    }

    // Anyone can open this URL in a signed-in browser, and Auth0 may then sign in without a
    // prompt. So every new connection needs an explicit approval from this browser (RFC 8252
    // section 8.6), bound to exactly this request and to a nonce cookie the callback checks again.
    const request = { clientState, redirectUri, codeChallenge };
    const consentToken = url.searchParams.get('consent_token');
    const consent = consentToken ? await oauth.verifyCollectorConsent(consentToken) : null;
    const consentNonce = getCookie(c, COLLECTOR_CONSENT_COOKIE);
    if (!collectorConsentMatches(consent, consentNonce, request)) {
      const nextConsentNonce = crypto.randomUUID();
      const nextConsentToken = await oauth.signCollectorConsent({
        consentNonce: nextConsentNonce,
        clientState,
        redirectUri,
        ...(codeChallenge === undefined ? {} : { codeChallenge }),
      });
      await logger.flush();
      return new Response(renderCollectorConsentPage(request, nextConsentToken), {
        status: 200,
        headers: formPageHeaders(serializeCollectorConsentCookie(nextConsentNonce)),
      });
    }

    // Reuse the registered /mcp/callback (Auth0 only allows that path); the `collector:` state tag
    // tells the shared callback to run the Collector path rather than the MCP auth-code path.
    const callbackUrl = new URL('/mcp/callback', url.origin).toString();
    const state = await oauth.signState({
      consentNonce,
      clientState: `collector:${clientState}`,
      redirectUri,
      ...(codeChallenge === undefined ? {} : { codeChallenge, codeChallengeMethod: 'S256' }),
    });
    const auth0Url = oauth.buildAuth0AuthorizeUrl(state, callbackUrl);

    await logger.flush();
    return redirectPage(auth0Url);
  });
}
