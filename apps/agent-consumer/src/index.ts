/**
 * Agent ingest queue consumer. Drains AGENT_QUEUE, prices each Agent Message via the shared
 * `@trace-flow/pricing` catalog (one KV read per distinct `(provider, model)` per batch), and writes
 * one batched insert per base agent_* datasource through the shared `@trace-flow/tinybird-client`
 * transport. Stateless — no batching Durable Object; redelivery is idempotent under
 * `ReplacingMergeTree(IngestedAt)` FINAL. See `docs/adr/0012-agent-conversation-analytics.md` → "Transport".
 *
 * `processAgentBatch` is exported for in-process tests (drive it with stub messages + a fetch mock,
 * the only way to deterministically assert the ack / retry / DLQ paths). The default export wraps the
 * queue handler in Sentry for the deployed Worker; `withSentry` instruments the `queue` method and
 * initializes the client per invocation, so the manual `Sentry.captureException` / `captureMessage`
 * calls inside `processAgentBatch` report (the batch loop catches per-message and insert errors to
 * retry them rather than letting them escape, so they would otherwise never reach Sentry).
 */
import * as Sentry from '@sentry/cloudflare';
import type { AgentConsumerEnv } from './context';
import { processAgentBatch } from './consumer';

export { processAgentBatch } from './consumer';

const handler = {
  // The queue delivers untrusted bytes; `processAgentBatch` validates each body structurally and
  // dead-letters anything off-contract, so the handler accepts `unknown` rather than asserting shape.
  async queue(batch: MessageBatch<unknown>, env: AgentConsumerEnv): Promise<void> {
    await processAgentBatch(batch, env);
  },
};

export default Sentry.withSentry(
  (env: AgentConsumerEnv) => ({
    dsn: env.SENTRY_DSN,
    release: env.CF_VERSION_METADATA?.id,
    environment: env.SENTRY_ENVIRONMENT ?? 'development',
    tracesSampleRate: 0.1,
  }),
  handler,
);
