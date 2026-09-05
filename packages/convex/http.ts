import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HttpRouterWithHono } from 'convex-helpers/server/hono';
import type { HonoWithConvex } from 'convex-helpers/server/hono';
import { registerRoutes as registerLaunchDarklyRoutes } from '@convex-dev/launchdarkly';
import type { ActionCtx } from './_generated/server';
import { components } from './_generated/api';
import * as oauthModule from './mcp/oauth';
import * as tokensModule from './mcp/tokens';
import type { HttpDeps } from './httpRoutes/deps';
import { registerAgentIngestRoutes } from './httpRoutes/agentIngest';
import { registerArchiveAuditRoutes } from './httpRoutes/archiveAudit';
import { registerArchiveAuthorizeRoutes } from './httpRoutes/archiveAuthorize';
import { registerArchiveKeyRoutes } from './httpRoutes/archiveKey';
import { registerArchiveStatusRoutes } from './httpRoutes/archiveStatus';
import { registerCollectorAuthorizeRoutes } from './httpRoutes/collectorAuthorize';
import { registerMcpAuthorizeRoutes } from './httpRoutes/mcpAuthorize';
import { registerMcpBackendRoutes } from './httpRoutes/mcpBackend';
import { registerMcpCallbackRoutes } from './httpRoutes/mcpCallback';
import { registerMcpDiscoveryRoutes } from './httpRoutes/mcpDiscovery';
import { registerMcpTokenRoutes } from './httpRoutes/mcpToken';
import { registerStripeWebhookRoutes } from './httpRoutes/stripeWebhook';
import { registerUsageRoutes } from './httpRoutes/usage';

export type { HttpDeps };

// Factory function for creating the Hono app (exported for testing)
export function createApp(
  deps: HttpDeps = { oauth: oauthModule, tokens: tokensModule },
): HonoWithConvex<ActionCtx> {
  const app: HonoWithConvex<ActionCtx> = new Hono();

  app.use(
    '*',
    cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization', 'Mcp-Session-Id', 'Mcp-Protocol-Version'],
      maxAge: 86400,
    }),
  );

  registerStripeWebhookRoutes(app);
  registerMcpDiscoveryRoutes(app);
  registerMcpAuthorizeRoutes(app, deps);
  registerMcpCallbackRoutes(app, deps);
  registerMcpTokenRoutes(app, deps);
  registerUsageRoutes(app);
  registerAgentIngestRoutes(app);
  registerArchiveAuthorizeRoutes(app);
  registerArchiveAuditRoutes(app);
  registerArchiveKeyRoutes(app);
  registerArchiveStatusRoutes(app);
  registerMcpBackendRoutes(app);
  registerCollectorAuthorizeRoutes(app, deps);

  return app;
}

// Production export (unchanged behavior)
const httpRouter = new HttpRouterWithHono(createApp());

// LaunchDarkly webhook (component pushes flag updates here).
registerLaunchDarklyRoutes(components.launchdarkly, httpRouter);

export default httpRouter;
