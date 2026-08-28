/**
 * LLM Proxy Worker — streams responses while capturing for observability.
 *
 * Handler is a 4-stage pipeline: validate → forward → attach → respond.
 * Capture runs in `waitUntil` after the response is returned so observability
 * never blocks the client.
 *
 * `tee()` is required because Workers streams are read-once and both consumers
 * (proxy fetch + capture) need their own reader. `waitUntil` is required
 * because the Worker terminates as soon as the response is returned.
 */
import * as Sentry from '@sentry/cloudflare';
import { OpenAPIHono } from '@hono/zod-openapi';
import { applySecurityHeaders } from '@trace-flow/utils';
import { TRACE_FLOW_PROPAGATION_TARGETS } from '@trace-flow/utils/sentry-tracing';
import type { ProxyEnv } from './context';
import { handleOTLPTraces } from './otlp';
import { otlpTracesRoute } from './otlp/routes';
import { validateRequest } from './pipeline/validateRequest';
import { forwardToUpstream } from './pipeline/forwardToUpstream';
import { attachCapture } from './pipeline/attachCapture';
import { respond } from './pipeline/respond';
import {
  buildTransaction,
  drainCapture,
  persistTransaction,
  recordSkippedExchange,
} from './transaction';
export { UsageTracker } from './usage-tracker';

const app = new OpenAPIHono<{ Bindings: ProxyEnv }>();

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
  servers: [{ url: 'https://trace-flow.dev', description: 'Production' }],
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

  const forwarded = await forwardToUpstream(c, validated);
  const attached = attachCapture(forwarded);

  const { decision, route, omitBody, logger } = validated;
  const tier = validated.usageCheck.status !== 'error' ? validated.usageCheck.tier : undefined;

  c.executionCtx.waitUntil(
    decision.record
      ? (async () => {
          try {
            const drained = await drainCapture(attached);
            const transaction = buildTransaction(drained, logger);
            await persistTransaction(c.env, transaction, { tier, route, omitBody, logger });
          } catch (err) {
            logger.error('proxy.capture_failed', err);
            await logger.flush();
          }
        })()
      : recordSkippedExchange(c.env, attached, { decision, route, logger }),
  );

  return respond(attached);
});

export default Sentry.withSentry(
  (env: ProxyEnv) => ({
    dsn: env.SENTRY_DSN,
    release: env.CF_VERSION_METADATA?.id,
    environment: env.SENTRY_ENVIRONMENT ?? 'development',
    tracesSampleRate: 1.0,
    tracePropagationTargets: TRACE_FLOW_PROPAGATION_TARGETS,
  }),
  app,
);
