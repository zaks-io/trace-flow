import type { CollectorConsentPayload } from '../mcp/oauth';
import { escapeHtml, hiddenInput, renderPage } from './htmlPage';
import { OUT_OF_BAND_REDIRECT } from './redirectUris';

/** The parts of a Collector sign-in request that its consent must match exactly. */
export interface CollectorAuthorizeRequest {
  clientState: string;
  redirectUri: string;
  codeChallenge?: string;
}

export function renderCollectorConsentPage(
  request: CollectorAuthorizeRequest,
  consentToken: string,
): string {
  const outOfBand = request.redirectUri === OUT_OF_BAND_REDIRECT;
  const hidden = [
    hiddenInput('redirect_uri', request.redirectUri),
    hiddenInput('state', request.clientState),
    hiddenInput('code_challenge', request.codeChallenge),
    hiddenInput('code_challenge_method', request.codeChallenge === undefined ? undefined : 'S256'),
    hiddenInput('consent_token', consentToken),
  ].join('\n');

  let started = '<code>trace-flow login --no-browser</code>';
  let next = 'After you sign in, this tab shows a code to paste into that terminal.';
  let cancel = '';
  if (!outOfBand) {
    started = '<code>trace-flow login</code> or chose Connect in Trace Flow Desktop';
    next = 'After you sign in, Trace Flow on this computer finishes connecting.';
    const denyUrl = new URL(request.redirectUri);
    denyUrl.searchParams.set('error', 'access_denied');
    denyUrl.searchParams.set('state', request.clientState);
    cancel = `<a href="${escapeHtml(denyUrl.toString())}">Cancel</a>`;
  }

  return renderPage(
    'Connect a Trace Flow Collector',
    `<h1>Connect a Trace Flow Collector</h1>
    <p>A Collector is asking to upload redacted agent analytics to your Trace Flow organization.</p>
    <p>Continue only if you just ran ${started}. ${next}</p>
    <div class="actions">
      <form method="get" action="/collector/authorize">
        ${hidden}
        <button type="submit">Continue</button>
      </form>
      ${cancel}
    </div>`,
  );
}

export function collectorConsentMatches(
  consent: CollectorConsentPayload | null,
  consentNonce: string | undefined,
  request: CollectorAuthorizeRequest,
): boolean {
  return (
    consent !== null &&
    consentNonce !== undefined &&
    consent.consentNonce === consentNonce &&
    consent.clientState === request.clientState &&
    consent.redirectUri === request.redirectUri &&
    consent.codeChallenge === request.codeChallenge
  );
}

export function renderCollectorCodePage(code: string): string {
  return renderPage(
    'Paste this code into your terminal',
    `<h1>Paste this code into your terminal</h1>
    <code class="code">${escapeHtml(code)}</code>
    <p>Paste it where <code>trace-flow login --no-browser</code> is waiting. It works once, within
    10 minutes, and only in that terminal. Do not share it: it connects a Collector to your
    organization.</p>
    <p>You can close this tab afterwards.</p>`,
  );
}
