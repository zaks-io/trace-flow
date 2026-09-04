import type * as oauthModule from '../mcp/oauth';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function hiddenInput(name: string, value: string | undefined): string {
  if (value === undefined) return '';
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

export function renderMcpConsentPage(params: {
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

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize MCP Client</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: Canvas;
      color: CanvasText;
    }
    main {
      width: min(520px, calc(100vw - 32px));
      border: 1px solid color-mix(in srgb, CanvasText 16%, transparent);
      border-radius: 8px;
      padding: 24px;
    }
    h1 { margin: 0 0 16px; font-size: 20px; line-height: 1.2; }
    dl { display: grid; gap: 12px; margin: 0 0 24px; }
    dt { font-size: 12px; font-weight: 700; text-transform: uppercase; color: color-mix(in srgb, CanvasText 62%, transparent); }
    dd { margin: 4px 0 0; overflow-wrap: anywhere; }
    .actions { display: flex; gap: 12px; align-items: center; }
    button, a {
      border: 1px solid color-mix(in srgb, CanvasText 20%, transparent);
      border-radius: 6px;
      padding: 9px 14px;
      font: inherit;
      color: CanvasText;
      text-decoration: none;
      background: Canvas;
    }
    button { background: CanvasText; color: Canvas; cursor: pointer; }
  </style>
</head>
<body>
  <main>
    <h1>Authorize MCP Client</h1>
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
    </div>
  </main>
</body>
</html>`;
}

export function consentMatchesRequest(
  consent: oauthModule.ConsentPayload | null,
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
    consent.clientId === request.clientId &&
    consent.clientState === request.clientState &&
    consent.redirectUri === request.redirectUri &&
    consent.resource === request.resource &&
    consent.codeChallenge === request.codeChallenge &&
    consent.codeChallengeMethod === request.codeChallengeMethod &&
    (consent.responseType ?? null) === request.responseType
  );
}
