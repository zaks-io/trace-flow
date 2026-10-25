import type * as oauthModule from '../mcp/oauth';
import { escapeHtml, hiddenInput, renderPage } from './htmlPage';

export function renderMcpConsentPage(params: {
  issuer: string;
  clientId: string;
  clientName?: string;
  responseType: string | null;
  clientState: string;
  redirectUri: string;
  resource: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  consentToken: string;
}) {
  const redirectUrl = new URL(params.redirectUri);
  redirectUrl.searchParams.set('error', 'access_denied');
  redirectUrl.searchParams.set('error_description', 'User denied MCP authorization');
  redirectUrl.searchParams.set('iss', params.issuer);
  if (params.clientState) redirectUrl.searchParams.set('state', params.clientState);

  const trimmedClientName = params.clientName?.trim();
  const clientLabel =
    trimmedClientName === undefined || trimmedClientName === ''
      ? params.clientId
      : trimmedClientName;
  const hidden = [
    hiddenInput('response_type', params.responseType ?? undefined),
    hiddenInput('client_id', params.clientId),
    hiddenInput('redirect_uri', params.redirectUri),
    hiddenInput('resource', params.resource),
    hiddenInput('state', params.clientState),
    hiddenInput('code_challenge', params.codeChallenge),
    hiddenInput('code_challenge_method', params.codeChallengeMethod),
    hiddenInput('consent_token', params.consentToken),
  ].join('\n');

  return renderPage(
    'Authorize MCP Client',
    `<h1>Authorize MCP Client</h1>
    <dl>
      <div>
        <dt>Client</dt>
        <dd>${escapeHtml(clientLabel)}</dd>
      </div>
      <div>
        <dt>Redirect URI</dt>
        <dd>${escapeHtml(params.redirectUri)}</dd>
      </div>
      <div>
        <dt>Resource</dt>
        <dd>${escapeHtml(params.resource)}</dd>
      </div>
      <div>
        <dt>Access</dt>
        <dd>Trace Flow account metadata and scoped analytics tokens for MCP tools.</dd>
      </div>
    </dl>
    <div class="actions">
      <form method="get" action="/mcp/authorize">
        ${hidden}
        <button type="submit">Continue</button>
      </form>
      <a href="${escapeHtml(redirectUrl.toString())}">Deny</a>
    </div>`,
  );
}

export function consentMatchesRequest(
  consent: oauthModule.ConsentPayload | null,
  consentNonce: string | undefined,
  request: {
    clientId: string;
    clientState: string;
    redirectUri: string;
    resource: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    responseType: string | null;
  },
): boolean {
  return (
    consent !== null &&
    consentNonce !== undefined &&
    consent.consentNonce === consentNonce &&
    consent.clientId === request.clientId &&
    consent.clientState === request.clientState &&
    consent.redirectUri === request.redirectUri &&
    consent.resource === request.resource &&
    consent.codeChallenge === request.codeChallenge &&
    consent.codeChallengeMethod === request.codeChallengeMethod &&
    (consent.responseType ?? null) === request.responseType
  );
}
