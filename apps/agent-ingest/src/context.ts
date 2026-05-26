import type { AgentIngestQueueMessage } from '@trace-flow/types';

/**
 * Bindings for the agent-ingest Worker. All bindings are required — a misconfigured deploy must
 * fail loudly rather than silently degrade (no defensive optionals). SENTRY_DSN and
 * CF_VERSION_METADATA are the only optionals: Sentry is absent in local/dev and the version
 * binding is injected by the platform.
 */
export interface AgentIngestEnv {
  /** Convex-synced Collector Credential records, keyed `collector:<sha256-hex-of-secret>`. */
  COLLECTOR_CREDS: KVNamespace;
  /** Producer for the agent ingest queue; the consumer (2c) prices + writes to Tinybird. */
  AGENT_QUEUE: Queue<AgentIngestQueueMessage>;
  /** Per-org ingest burst limit (namespace 2006). */
  AGENT_INGEST_LIMITER: RateLimit;
  /** Convex HTTP site URL, e.g. `https://{deployment}.convex.site`. */
  CONVEX_SITE_URL: string;
  /** Shared secret for the `/agent-ingest/*` Convex routes (Bearer). */
  AGENT_INGEST_SHARED_SECRET: string;
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  CF_VERSION_METADATA?: { id: string };
  AXIOM_TOKEN?: string;
  AXIOM_DATASET?: string;
  AXIOM_DOMAIN?: string;
}
