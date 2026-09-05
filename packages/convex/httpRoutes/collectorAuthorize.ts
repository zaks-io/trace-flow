import type { HonoWithConvex } from 'convex-helpers/server/hono';
import type { ActionCtx } from '../_generated/server';
import type { HttpDeps } from './deps';
import { redirectLoopbackAuthorize } from './loopbackAuthorize';

export function registerCollectorAuthorizeRoutes(
  app: HonoWithConvex<ActionCtx>,
  { oauth }: HttpDeps,
): void {
  // Collector CLI login: start the browser device flow. The CLI opens this URL with a loopback
  // `redirect_uri`; we sign it into the OAuth state and bounce to Auth0, reusing the exact MCP
  // authorize machinery. The minted secret is delivered to that loopback by /collector/callback.
  // The `collector:` state tag tells the shared callback to mint a Collector Credential rather
  // than run the MCP auth-code path or the archive-session path.
  app.get('/collector/authorize', async (c) =>
    redirectLoopbackAuthorize(c, oauth, {
      operation: 'collector_authorize',
      badRedirectEvent: 'convex.collector_authorize_bad_redirect',
      clientStatePrefix: 'collector:',
    }),
  );
}
