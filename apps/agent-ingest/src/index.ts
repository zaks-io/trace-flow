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
import { Hono } from 'hono';
import type { AgentIngestEnv } from './context';
import { handleIngest } from './handler';

export const app = new Hono<{ Bindings: AgentIngestEnv }>();

app.get('/health', (c) => c.json({ status: 'ok' }));

app.post('/v1/ingest', handleIngest);

export default Sentry.withSentry(
  (env: AgentIngestEnv) => ({
    dsn: env.SENTRY_DSN,
    release: env.CF_VERSION_METADATA?.id,
    environment: env.SENTRY_ENVIRONMENT ?? 'development',
    tracesSampleRate: 0.1,
  }),
  app,
);
