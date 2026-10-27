import type { HonoWithConvex } from 'convex-helpers/server/hono';
import type { ActionCtx } from '../_generated/server';
import { getCookie } from 'hono/cookie';
import { internal } from '../_generated/api';
import type { HttpDeps } from './deps';
import { formPageHeaders, redirectPage } from './htmlPage';
import { consentMatchesRequest, renderMcpConsentPage } from './mcpConsentPage';
import { MCP_CONSENT_COOKIE, serializeMcpConsentCookie } from './consentCookies';
import { isAllowedMcpOAuthHost } from './mcpOAuthHost';
import { isValidS256Challenge } from './mcpPkce';
import { canonicalizeMcpResource } from './redirectUris';

export function registerMcpAuthorizeRoutes(
  app: HonoWithConvex<ActionCtx>,
  { oauth }: HttpDeps,
): void {
  // OAuth: Start authorization flow
  app.get('/mcp/authorize', async (c) => {
    if (!isAllowedMcpOAuthHost(c.req.raw)) {
      return c.json({ error: 'forbidden_host' }, 403);
    }
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
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'resource must identify a Trace Flow MCP endpoint',
        },
        400,
      );
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
    if (!isValidS256Challenge(codeChallenge)) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'code_challenge must be a valid S256 PKCE challenge',
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
    const consentNonce = getCookie(c, MCP_CONSENT_COOKIE);

    if (!consentMatchesRequest(consent, consentNonce, authorizeRequest)) {
      const nextConsentNonce = crypto.randomUUID();
      const nextConsentToken = await oauth.signConsent({
        consentNonce: nextConsentNonce,
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
          issuer: url.origin,
          clientName: client.clientName,
          responseType,
          clientState,
          redirectUri,
          resource: canonicalResource,
          codeChallenge,
          codeChallengeMethod,
          consentToken: nextConsentToken,
        }),
        { status: 200, headers: formPageHeaders(serializeMcpConsentCookie(nextConsentNonce)) },
      );
    }

    const callbackUrl = new URL('/mcp/callback', url.origin).toString();

    const state = await oauth.signState({
      consentNonce,
      clientState,
      clientId,
      redirectUri,
      resource: canonicalResource,
      codeChallenge,
      codeChallengeMethod,
    });

    const auth0Url = oauth.buildAuth0AuthorizeUrl(state, callbackUrl);

    return redirectPage(auth0Url);
  });
}
