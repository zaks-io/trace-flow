import type { AgentIngestQueueMessage } from './agent-ingest';
import type { EncryptedStoredBodiesPayload } from './storage';

/** Small Queue message pointing at one encrypted, durable analytics chunk in R2. */
export interface AgentDeliveryReference {
  type: 'agent-delivery';
  version: 1;
  key: string;
  org_id: string;
  sha256: string;
  created_at: number;
  expires_at: number;
  delivery_revision: number;
}

/** Durable R2 reference before the consumer coordinator assigns its acceptance revision. */
export type AgentDeliveryStagedReference = Omit<AgentDeliveryReference, 'delivery_revision'>;

/** Encrypted R2 object referenced by {@link AgentDeliveryReference}. */
export interface AgentDeliveryEnvelope {
  version: 1;
  created_at: number;
  expires_at: number;
  sha256: string;
  encryptedPayload: EncryptedStoredBodiesPayload;
}

/** Rolling-deploy Queue contract. Consumers must accept old inline messages until they drain. */
export type AgentIngestQueuePayload = AgentIngestQueueMessage | AgentDeliveryReference;

export interface AgentSnapshotQueueMessage {
  type: 'agent-snapshot';
  org_id: string;
}
