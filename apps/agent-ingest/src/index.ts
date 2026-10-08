import { sentryRequestPrivacy } from '@trace-flow/utils/sentry-tracing';
/**
 * Agent Collector ingest Worker. Authenticates the Collector Credential, enforces the compatibility
 * policy and per-org rate limit, re-redacts free-text fields, assembles canonical `*_pk` surrogates
 * + `repo_fingerprint`, claims first-writer session ownership, and stages encrypted deliveries in
 * R2 before enqueuing references for the agent consumer (2c).
 *
 * The bare `app` is exported for in-process tests (`app.fetch(req, env, ctx)` with stub bindings, the
 * only way to deterministically drive the RateLimit / Queue / Convex failure paths). The default
 * export wraps it in Sentry for the deployed Worker.
 */
import * as Sentry from '@sentry/cloudflare';
import { tracing } from 'cloudflare:workers';
import { TRACE_FLOW_PROPAGATION_TARGETS } from '@trace-flow/utils/sentry-tracing';
import { withNativeTrace } from '@trace-flow/utils/native-tracing';
import { normalizeTraceRequest } from '@trace-flow/utils/ingress-tracing';
import { Hono } from 'hono';
import type { AgentIngestEnv } from './context';
import { handleIngest } from './handler';
import { handleOrganizationErasure } from './organization-erasure';

export const app = new Hono<{ Bindings: AgentIngestEnv }>();

app.use('*', (_c, next) => withNativeTrace(tracing, 'trace_flow.agent_ingest_request', next));

app.get('/healthz', (c) => c.json({ status: 'ok' }));

app.post('/v1/ingest', handleIngest);
app.post('/internal/organization-erasure', handleOrganizationErasure);

const instrumentedApp = Sentry.withSentry(
  (env: AgentIngestEnv) => ({
    dsn: env.SENTRY_DSN,
    release: env.CF_VERSION_METADATA?.id,
    environment: env.SENTRY_ENVIRONMENT ?? 'development',
    tracesSampleRate: 1.0,
    tracePropagationTargets: TRACE_FLOW_PROPAGATION_TARGETS,
    ...sentryRequestPrivacy(),
    enableRpcTracePropagation: true,
    rpcTracePropagationBindings: ['AGENT_CONSUMER'],
  }),
  app,
);

export default {
  fetch(request: Request, env: AgentIngestEnv, ctx: ExecutionContext) {
    return instrumentedApp.fetch(normalizeTraceRequest(request), env, ctx);
  },
} satisfies ExportedHandler<AgentIngestEnv>;
