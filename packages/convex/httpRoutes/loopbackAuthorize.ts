import { isLoopbackRedirect } from './redirectUris';
import { getRequestLogger } from './shared';

export async function redirectLoopbackAuthorize(
  c: {
    req: { url: string; raw: Request };
    json: (data: unknown, status?: number) => Response;
  },
  oauth: {
    signState: (payload: { clientState: string; redirectUri: string }) => Promise<string>;
    buildAuth0AuthorizeUrl: (state: string, callbackUrl: string) => string;
  },
  options: {
    operation: string;
    badRedirectEvent: string;
    clientStatePrefix: string;
  },
): Promise<Response> {
  const logger = getRequestLogger(c.req.raw, { operation: options.operation });
  const url = new URL(c.req.url);
  const redirectUri = url.searchParams.get('redirect_uri');
  const clientState = url.searchParams.get('state') ?? '';
  if (!redirectUri) {
    return c.json({ error: 'redirect_uri is required' }, 400);
  }
  if (!isLoopbackRedirect(redirectUri)) {
    logger.warn(options.badRedirectEvent);
    await logger.flush();
    return c.json({ error: 'redirect_uri must be a loopback (127.0.0.1) address' }, 400);
  }

  const callbackUrl = new URL('/mcp/callback', url.origin).toString();
  const state = await oauth.signState({
    clientState: `${options.clientStatePrefix}${clientState}`,
    redirectUri,
  });
  const auth0Url = oauth.buildAuth0AuthorizeUrl(state, callbackUrl);
  await logger.flush();
  return new Response(null, {
    status: 302,
    headers: { Location: auth0Url, 'Cache-Control': 'no-store' },
  });
}
