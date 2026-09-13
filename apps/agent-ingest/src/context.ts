import type { AgentDeliveryStagedReference, AgentIngestQueuePayload } from '@trace-flow/types';

export interface AgentConsumerService {
  eraseOrganization(
    orgId: string,
    afterId?: number,
  ): Promise<{ ready: boolean; nextAfterId?: number }>;
  canAcceptDeliveries(orgId: string): Promise<boolean>;
  registerDelivery(reference: AgentDeliveryStagedReference, days: string[]): Promise<number>;
}

/**
 * Bindings for the agent-ingest Worker. All bindings are required — a misconfigured deploy must
 * fail loudly rather than silently degrade (no defensive optionals). SENTRY_DSN and
 * CF_VERSION_METADATA are the only optionals: Sentry is absent in local/dev and the version
 * binding is injected by the platform.
 */
export interface AgentIngestEnv {
  /** Explicit cutover gate. Missing or invalid values fail closed. */
  AGENT_INGEST_MAINTENANCE: 'true' | 'false';
  /** Convex-synced Collector Credential records, keyed `collector:<sha256-hex-of-secret>`. */
  COLLECTOR_CREDS: KVNamespace;
  /** Producer for the agent ingest queue; the consumer (2c) prices + writes to Tinybird. */
  AGENT_QUEUE: Queue<AgentIngestQueuePayload>;
  /** Encrypted, bounded queue payloads. Queue messages carry references to these durable objects. */
  AGENT_DELIVERIES: R2Bucket;
  /** Assigns the per-organization acceptance revision before a delivery reaches the Queue. */
  AGENT_CONSUMER: AgentConsumerService;
  /** Root key for per-organization, per-object AES-GCM delivery encryption. */
  BODY_ENCRYPTION_ROOT_KEY: string;
  /** Existing body-encryption key version. Defaults to v1 in the shared crypto helper. */
  BODY_ENCRYPTION_KEY_ID?: string;
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
