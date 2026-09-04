import type { HonoWithConvex } from 'convex-helpers/server/hono';
import type { ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { HttpDeps } from './deps';
import { consentMatchesRequest, renderMcpConsentPage } from './mcpConsentPage';
import { canonicalizeMcpResource } from './redirectUris';

export function registerMcpAuthorizeRoutes(
  app: HonoWithConvex<ActionCtx>,
  { oauth }: HttpDeps,
): void {
  // OAuth: Start authorization flow
  app.get('/mcp/authorize', async (c) => {
    const ctx = c.env;
    const url = new URL(c.req.url);
    const responseType = url.searchParams.get('response_type');
    const clientId = url.searchParams.get('client_id');
    const clientState = url.searchParams.get('state') ?? '';
    const redirectUri = url.searchParams.get('redirect_uri');
    const resource = url.searchParams.get('resource');
    const codeChallenge = url.searchParams.get('code_challenge') ?? undefined;
    const codeChallengeMethod = url.searchParams.get('code_challenge_method') ?? undefined;

    if (responseType && responseType !== 'code') {
      return c.json(
        { error: 'unsupported_response_type', error_description: 'response_type must be code' },
        400,
      );
    }

    if (!clientId) {
      return c.json({ error: 'invalid_request', error_description: 'client_id is required' }, 400);
    }

    if (!redirectUri) {
      return c.json(
        { error: 'invalid_request', error_description: 'redirect_uri is required' },
        400,
      );
    }

    const client = await ctx.runQuery(internal.mcp.clients.getClient, { clientId });
    if (!Array.isArray(client?.redirectUris) || !client.redirectUris.includes(redirectUri)) {
      return c.json(
        { error: 'invalid_request', error_description: 'redirect_uri is not registered' },
        400,
      );
    }

    const canonicalResource = resource ? canonicalizeMcpResource(resource) : null;
    if (!canonicalResource) {
      return c.json({ error: 'invalid_request', error_description: 'resource is required' }, 400);
    }

    if (!codeChallenge || codeChallengeMethod !== 'S256') {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'PKCE code_challenge_method must be S256',
        },
        400,
      );
    }

    const authorizeRequest = {
      clientId,
      clientState,
      redirectUri,
      resource: canonicalResource,
      codeChallenge,
      codeChallengeMethod,
      responseType,
    };
    const consentToken = url.searchParams.get('consent_token');
    const consent = consentToken ? await oauth.verifyConsent(consentToken) : null;

    if (!consentMatchesRequest(consent, authorizeRequest)) {
      const nextConsentToken = await oauth.signConsent({
        clientId,
        clientState,
        redirectUri,
        resource: canonicalResource,
        codeChallenge,
        codeChallengeMethod,
        ...(responseType === null ? {} : { responseType }),
      });

      return new Response(
        renderMcpConsentPage({
          clientId,
          clientName: client.clientName,
          responseType,
          clientState,
          redirectUri,
          resource: canonicalResource,
          codeChallenge,
          codeChallengeMethod,
          consentToken: nextConsentToken,
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            'Content-Security-Policy':
              "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
            'Referrer-Policy': 'no-referrer',
          },
        },
      );
    }

    const callbackUrl = new URL('/mcp/callback', url.origin).toString();

    const state = await oauth.signState({
      clientState,
      clientId,
      redirectUri,
      resource: canonicalResource,
      codeChallenge,
      codeChallengeMethod,
    });

    const auth0Url = oauth.buildAuth0AuthorizeUrl(state, callbackUrl);

    // This branch is reached by the consent form's GET submission. Chrome checks the consent
    // page's `form-action 'self'` CSP against every redirect hop of that submission, so a 302
    // here (self -> Auth0, and on silent SSO all the way to the client's localhost callback)
    // gets blocked. A 200 HTML redirect ends the form-submission chain before the
    // cross-origin navigation.
    const redirectHtml = `<!DOCTYPE html>
<html>
<head>
  <meta http-equiv="refresh" content="0;url=${auth0Url}">
  <title>Redirecting...</title>
</head>
<body>
  <p>Redirecting to authentication... <a href="${auth0Url}">Click here if not redirected</a></p>
  <script>window.location.replace("${auth0Url}");</script>
</body>
</html>`;

    return new Response(redirectHtml, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    });
  });
}
