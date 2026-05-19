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
import { captureAndEnqueue, cleanupSkippedCapture } from './capture';
import type { CaptureContext, ProxyEnv } from './context';
import { handleOTLPTraces } from './otlp';
import { otlpTracesRoute } from './otlp/routes';
import { validateRequest } from './pipeline/validateRequest';
import { forwardToUpstream } from './pipeline/forwardToUpstream';
import { attachCapture } from './pipeline/attachCapture';
import { respond } from './pipeline/respond';
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

app.all('*', async (c) => {
  const validateResult = await validateRequest(c);
  if (validateResult.kind === 'reject') return validateResult.response;
  const validated = validateResult.validated;

  const forwarded = await forwardToUpstream(c, validated);
  const attached = attachCapture(forwarded.response, validated.route.provider);

  const ctx: CaptureContext = {
    env: c.env,
    ...validated,
    ...forwarded,
    ...attached,
  };

  c.executionCtx.waitUntil(
    ctx.decision.record ? captureAndEnqueue(ctx) : cleanupSkippedCapture(ctx),
  );

  return respond(ctx);
});

export default Sentry.withSentry(
  (env: ProxyEnv) => ({
    dsn: env.SENTRY_DSN,
    release: env.CF_VERSION_METADATA?.id,
    environment: env.SENTRY_ENVIRONMENT ?? 'development',
    tracesSampleRate: 0.1,
  }),
  app,
);
