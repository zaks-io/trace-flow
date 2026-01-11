import * as Sentry from '@sentry/cloudflare';

// Re-export Durable Objects from OpenNext (required for Cloudflare)
export { DOQueueHandler, DOShardedTagCache, BucketCachePurge } from '../.open-next/worker.js';

import openNextHandler from '../.open-next/worker.js';

interface Env {
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  CF_VERSION_METADATA?: { id: string };
  [key: string]: unknown;
}

export default Sentry.withSentry(
  (env: Env) => ({
    dsn: env.SENTRY_DSN,
    release: env.CF_VERSION_METADATA?.id,
    environment: env.SENTRY_ENVIRONMENT ?? 'production',
    tracesSampleRate: env.SENTRY_ENVIRONMENT === 'development' ? 1.0 : 0.1,
  }),
  {
    fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      return openNextHandler.fetch(request, env, ctx);
    },
  },
);
