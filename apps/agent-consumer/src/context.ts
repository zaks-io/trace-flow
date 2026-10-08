import type { AgentDeliveryReference, AgentSnapshotQueueMessage } from '@trace-flow/types';
import type { AgentFactBatcherInstance } from './fact-batcher';
import type { AgentDeliveryInstance } from './agent-delivery';
import type { AgentDeliveryCoordinatorInstance } from './agent-delivery-coordinator';
import type { SnapshotCapacityInstance } from './snapshot-capacity';

/**
 * Bindings for the agent-consumer Worker. All bindings are required; a misconfigured deploy must
 * fail loudly rather than silently degrade (no defensive optionals). SENTRY_DSN, CF_VERSION_METADATA,
 * and the Axiom vars are the only optionals: Sentry/Axiom are absent in local/dev and the version
 * binding is injected by the platform.
 */
export interface AgentConsumerEnv {
  /** The agent ingest queue the worker (2b) produces to; this consumer prices + writes its facts. */
  AGENT_QUEUE: Queue<AgentDeliveryReference>;
  AGENT_SNAPSHOT_QUEUE: Queue<AgentSnapshotQueueMessage>;
  AGENT_DELIVERIES: R2Bucket;
  BODY_ENCRYPTION_ROOT_KEY: string;
  AGENT_DELIVERY: DurableObjectNamespace<AgentDeliveryInstance>;
  AGENT_DELIVERY_COORDINATOR: DurableObjectNamespace<AgentDeliveryCoordinatorInstance>;
  AGENT_SNAPSHOT_CAPACITY: DurableObjectNamespace<SnapshotCapacityInstance>;
  /** Only the delivery receipt and identity lookup pipes; never a workspace admin token. */
  TINYBIRD_AGENT_DELIVERY_READ_TOKEN: string;
  TINYBIRD_AGENT_SNAPSHOT_TOKEN: string;
  TINYBIRD_AGENT_SNAPSHOT_JOBS_TOKEN: string;
  /** Shared model pricing catalog, keyed `pricing:<provider>:<model>` (models.dev import, 2d). */
  MODEL_PRICING: KVNamespace;
  /** Shared org:__dlq__ preservation, recovery records and erasure of the retired fact ledger. */
  AGENT_FACT_BATCHER: DurableObjectNamespace<AgentFactBatcherInstance>;
  /** Tinybird Events API token with DATASOURCE:APPEND scope. */
  TINYBIRD_TOKEN: string;
  /** Tinybird regional API host, e.g. `https://api.us-west-2.aws.tinybird.co`. */
  TINYBIRD_HOST: string;
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  CF_VERSION_METADATA?: { id: string };
  AXIOM_TOKEN?: string;
  AXIOM_DATASET?: string;
  AXIOM_DOMAIN?: string;
}
