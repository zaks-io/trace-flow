/**
 * LLM Proxy Worker — streams responses while capturing for observability.
 *
 * Handler is a 4-stage pipeline: validate → forward → attach → respond.
 * The response streams immediately, but its terminal byte and EOF wait for the
 * durable R2 delivery envelope. Queue publication continues in `waitUntil()`.
 *
 * `tee()` is required because Workers streams are read-once and both consumers
 * (proxy fetch + capture) need their own reader.
 */
import * as Sentry from '@sentry/cloudflare';
import { OpenAPIHono } from '@hono/zod-openapi';
import { axiomConfigFromEnv, createLogger } from '@trace-flow/logging';
import { applySecurityHeaders } from '@trace-flow/utils';
import { TRACE_FLOW_PROPAGATION_TARGETS } from '@trace-flow/utils/sentry-tracing';
import type { ProxyEnv } from './context';
import { handleOTLPTraces } from './otlp';
import { otlpTracesRoute } from './otlp/routes';
import { validateRequest } from './pipeline/validateRequest';
import { forwardToUpstream, UpstreamFetchError } from './pipeline/forwardToUpstream';
import { attachCapture } from './pipeline/attachCapture';
import { respond } from './pipeline/respond';
import { sweepTraceDeliveries } from './delivery';
import {
  buildTransaction,
  buildUpstreamFailureTransaction,
  drainCapture,
  enqueuePersistedTransaction,
  persistTransaction,
  recordSkippedExchange,
} from './transaction';
export { UsageTracker } from './usage-tracker';

export const app = new OpenAPIHono<{ Bindings: ProxyEnv }>();

app.use('*', async (c, next) => {
  await next();
  applySecurityHeaders(c.res.headers);
});

app.openAPIRegistry.registerComponent('securitySchemes', 'apiKey', {
  type: 'apiKey',
  in: 'header',
  name: 'X-Trace-Flow-Api-Key',
  description: 'API key for authentication. Obtain from your Trace Flow dashboard.',
});

app.doc('/openapi.json', {
  openapi: '3.0.0',
  info: {
    title: 'Trace Flow API',
    version: '1.0.0',
    description: 'OpenTelemetry trace ingestion API for observability and analytics.',
  },
  servers: [{ url: 'https://gateway.trace-flow.dev', description: 'Production' }],
  tags: [{ name: 'Traces', description: 'OpenTelemetry trace ingestion endpoints' }],
  security: [{ apiKey: [] }],
});

app.post('/v1/traces', handleOTLPTraces);
app.openAPIRegistry.registerPath(otlpTracesRoute);

app.get('/healthz', (c) => c.json({ status: 'ok' }));

app.all('*', async (c) => {
  const validateResult = await validateRequest(c);
  if (validateResult.kind === 'reject') return validateResult.response;
  const { validated } = validateResult;

  const { decision, route, omitBody, logger } = validated;
  const tier = validated.usageCheck.status !== 'error' ? validated.usageCheck.tier : undefined;
  let forwarded;
  try {
    forwarded = await forwardToUpstream(c, validated);
  } catch (err) {
    logger.error('proxy.upstream_fetch_failed', err);
    if (err instanceof UpstreamFetchError && decision.record) {
      try {
        const transaction = await buildUpstreamFailureTransaction(err);
        const persisted = await persistTransaction(c.env, transaction, {
          tier,
          route,
          omitBody,
          logger,
        });
        c.executionCtx.waitUntil(enqueuePersistedTransaction(c.env, persisted, logger));
      } catch (persistError) {
        logger.error('proxy.failure_transaction_persist_failed', persistError);
        await logger.flush();
      }
    } else if (err instanceof UpstreamFetchError) {
      await err.exchange.streamToCapture?.cancel().catch(() => undefined);
      await logger.flush();
    }
    return c.json({ error: 'Upstream request failed', message: 'Retry the request' }, 502, {
      'Retry-After': '1',
    });
  }
  const attached = attachCapture(forwarded);

  if (decision.record) {
    const durableCapture = async (): Promise<boolean> => {
      try {
        const drained = await drainCapture(attached);
        const transaction = buildTransaction(drained, logger);
        if (transaction.streamError) {
          logger.error('proxy.response_stream_failed', transaction.streamError);
        }
        const persisted = await persistTransaction(c.env, transaction, {
          tier,
          route,
          omitBody,
          logger,
        });
        c.executionCtx.waitUntil(enqueuePersistedTransaction(c.env, persisted, logger));
        attached.capture.release();
      } catch (err) {
        logger.error('proxy.capture_failed', err);
        if (attached.pipePromise) {
          attached.capture.fail(err);
          await attached.pipePromise.catch((streamError: unknown) => {
            logger.error('proxy.response_stream_failed', streamError);
          });
        }
        c.executionCtx.waitUntil(logger.flush());
        return false;
      }

      try {
        await attached.pipePromise;
      } catch (err) {
        logger.error('proxy.response_stream_failed', err);
        c.executionCtx.waitUntil(logger.flush());
      }
      return true;
    };

    if (!attached.pipePromise) {
      if (!(await durableCapture())) {
        return c.json({ error: 'Trace persistence failed', message: 'Retry the request' }, 503, {
          'Retry-After': '1',
        });
      }
    } else {
      c.executionCtx.waitUntil(durableCapture());
    }
  } else {
    c.executionCtx.waitUntil(recordSkippedExchange(c.env, attached, { decision, route, logger }));
  }

  return respond(attached);
});

const handler = {
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },
  async scheduled(controller, env) {
    const logger = createLogger({
      service: 'proxy',
      runtime: 'cloudflare-worker',
      axiom: axiomConfigFromEnv(env),
      context: { component: 'trace-delivery-sweep' },
    });
    try {
      const enqueued = await sweepTraceDeliveries(
        env.STORAGE,
        env.REQUEST_QUEUE,
        logger,
        env.TRACE_DELIVERY_NAMESPACE,
      );
      logger.info('proxy.delivery_sweep_completed', { cron: controller.cron, enqueued });
    } catch (error) {
      logger.error('proxy.delivery_sweep_failed', error, { cron: controller.cron });
      throw error;
    } finally {
      await logger.flush();
    }
  },
} satisfies ExportedHandler<ProxyEnv>;

export default Sentry.withSentry(
  (env: ProxyEnv) => ({
    dsn: env.SENTRY_DSN,
    release: env.CF_VERSION_METADATA?.id,
    environment: env.SENTRY_ENVIRONMENT ?? 'development',
    tracesSampleRate: 1.0,
    tracePropagationTargets: TRACE_FLOW_PROPAGATION_TARGETS,
  }),
  handler,
);
