import * as Sentry from '@sentry/cloudflare';
import { axiomConfigFromEnv, createWorkerLogger } from '@trace-flow/logging';
import { TRACE_FLOW_PROPAGATION_TARGETS } from '@trace-flow/utils/sentry-tracing';

// Re-export Durable Objects from OpenNext (required for Cloudflare)
export { DOQueueHandler, DOShardedTagCache, BucketCachePurge } from '../.open-next/worker.js';

import openNextHandler from '../.open-next/worker.js';
import { negotiateMarkdown, type MarkdownConverter } from './markdown-negotiation';

interface Env {
  AI: MarkdownConverter;
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  CF_VERSION_METADATA?: { id: string };
  AXIOM_TOKEN?: string;
  AXIOM_DATASET?: string;
  AXIOM_DOMAIN?: string;
  [key: string]: unknown;
}

export default Sentry.withSentry(
  (env: Env) => ({
    dsn: env.SENTRY_DSN,
    release: env.CF_VERSION_METADATA?.id,
    environment: env.SENTRY_ENVIRONMENT ?? 'prod',
    tracesSampleRate: 1.0,
    sendDefaultPii: false,
    enableLogs: true,
    tracePropagationTargets: TRACE_FLOW_PROPAGATION_TARGETS,
    // OpenNext/Next already uses OpenTelemetry inside the same Worker bundle. Letting
    // @sentry/cloudflare replace the global OTEL provider recurses in routingHandler.
    skipOpenTelemetrySetup: true,
  }),
  {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const logger = createWorkerLogger({
        service: 'web',
        request,
        axiom: axiomConfigFromEnv(env),
        context: { component: 'http' },
      });
      const start = Date.now();
      try {
        const htmlResponse = await openNextHandler.fetch(request, env, ctx);
        const response = await negotiateMarkdown(request, htmlResponse, env.AI);
        logger.info('web.request_complete', {
          status: response.status,
          latencyMs: Date.now() - start,
        });
        return response;
      } catch (error) {
        logger.error('web.request_failed', error, {
          latencyMs: Date.now() - start,
        });
        throw error;
      } finally {
        ctx.waitUntil(logger.flush());
      }
    },
  },
);
