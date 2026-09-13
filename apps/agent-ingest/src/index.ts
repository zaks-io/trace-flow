/**
 * Agent Collector ingest Worker. Authenticates the Collector Credential, enforces the compatibility
 * policy and per-org rate limit, re-redacts free-text fields, assembles canonical `*_pk` surrogates
 * + `repo_fingerprint`, claims first-writer session ownership, and enqueues sub-128 KiB messages for
 * the agent consumer (2c). See `docs/adr/0012-agent-conversation-analytics.md` → "Transport".
 *
 * The bare `app` is exported for in-process tests (`app.fetch(req, env, ctx)` with stub bindings, the
 * only way to deterministically drive the RateLimit / Queue / Convex failure paths). The default
 * export wraps it in Sentry for the deployed Worker.
 */
import * as Sentry from '@sentry/cloudflare';
import { TRACE_FLOW_PROPAGATION_TARGETS } from '@trace-flow/utils/sentry-tracing';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import type { AgentIngestEnv } from './context';
import { handleIngest } from './handler';
import { handleOrganizationErasure } from './organization-erasure';

export const app = new Hono<{ Bindings: AgentIngestEnv }>();

app.get('/healthz', (c) => c.json({ status: 'ok' }));

const enforceIngestionMaintenance: MiddlewareHandler<{ Bindings: AgentIngestEnv }> = async (
  c,
  next,
) => {
  const maintenance = c.env.AGENT_INGEST_MAINTENANCE;
  if (maintenance !== 'true' && maintenance !== 'false') {
    throw new Error('Invalid AGENT_INGEST_MAINTENANCE configuration');
  }
  if (maintenance === 'true') {
    c.header('Retry-After', '60');
    return c.json({ error: 'ingestion_maintenance' }, 503);
  }
  await next();
};

app.post('/v1/ingest', enforceIngestionMaintenance, handleIngest);
app.post('/internal/organization-erasure', handleOrganizationErasure);

export default Sentry.withSentry(
  (env: AgentIngestEnv) => ({
    dsn: env.SENTRY_DSN,
    release: env.CF_VERSION_METADATA?.id,
    environment: env.SENTRY_ENVIRONMENT ?? 'development',
    tracesSampleRate: 1.0,
    tracePropagationTargets: TRACE_FLOW_PROPAGATION_TARGETS,
  }),
  app,
);
