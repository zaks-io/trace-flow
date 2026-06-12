import type { AgentIngestQueueMessage } from '@trace-flow/types';
import type { AgentFactBatcherInstance } from './fact-batcher';

/**
 * Bindings for the agent-consumer Worker. All bindings are required — a misconfigured deploy must
 * fail loudly rather than silently degrade (no defensive optionals). SENTRY_DSN, CF_VERSION_METADATA,
 * and the Axiom vars are the only optionals: Sentry/Axiom are absent in local/dev and the version
 * binding is injected by the platform.
 */
export interface AgentConsumerEnv {
  /** The agent ingest queue the worker (2b) produces to; this consumer prices + writes its facts. */
  AGENT_QUEUE: Queue<AgentIngestQueueMessage>;
  /** Shared model pricing catalog, keyed `pricing:<provider>:<model>` (models.dev import, 2d). */
  MODEL_PRICING: KVNamespace;
  /** Durable Object ledger that dedupes and batches facts before Tinybird insert. */
  AGENT_FACT_BATCHER: DurableObjectNamespace<AgentFactBatcherInstance>;
  /** Tinybird Events API token with DATASOURCE:APPEND scope. */
  TINYBIRD_TOKEN: string;
  /** Tinybird regional API host, e.g. `https://api.us-west-2.aws.tinybird.co`. */
  TINYBIRD_HOST: string;
  /**
   * Tinybird write mode. `clean` is steady state; `legacy` and `dual` are rollback-only rollout
   * modes for keeping the old ReplacingMergeTree path available during incident response.
   */
  TINYBIRD_AGENT_WRITE_MODE?: string;
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  CF_VERSION_METADATA?: { id: string };
  AXIOM_TOKEN?: string;
  AXIOM_DATASET?: string;
  AXIOM_DOMAIN?: string;
}
