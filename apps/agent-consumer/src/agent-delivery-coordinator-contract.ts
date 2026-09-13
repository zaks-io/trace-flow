export const MAX_ACTIVE_AGENT_DELIVERIES = 64;
export const MAX_AGENT_DIRTY_DAYS = 366;
export const MAX_AGENT_DELIVERY_RETENTION_MS = 4 * 24 * 60 * 60 * 1000;
export const MAX_AGENT_SNAPSHOT_LEASE_MS = 5 * 60 * 1000;
export const MAX_AGENT_SNAPSHOT_DAYS = 7;

export interface ReserveAgentDeliveryInput {
  deliveryId: string;
  payloadSha256: string;
  dirtyDays: string[];
  createdAtMs: number;
  expiresAtMs: number;
}

export interface AgentDeliveryReservation {
  deliveryId: string;
  payloadSha256: string;
  deliverySequence: number;
  dirtyDays: string[];
  createdAtMs: number;
  expiresAtMs: number;
}

export interface BeginAgentSnapshotResult {
  generation: number;
  dirtyDays: string[];
}

export interface AgentDeliveryCoordinatorStats {
  lastDeliverySequence: number;
  lastSnapshotGeneration: number;
  activeDeliveries: number;
  dirtyDays: number;
  incompleteDays: number;
  capturedSnapshotDays: number;
  gatePhase: 'open' | 'draining' | 'snapshot';
  activeSnapshotGeneration: number | null;
  gateExpiresAtMs: number | null;
  databaseSizeBytes: number;
}

export type CoordinatorState = Record<string, string | number | null> & {
  last_delivery_sequence: number;
  last_snapshot_generation: number;
  gate_phase: 'open' | 'draining' | 'snapshot';
  active_snapshot_generation: number | null;
  gate_expires_at_ms: number | null;
};

export type StoredReservation = Record<string, string | number> & {
  delivery_id: string;
  payload_sha256: string;
  delivery_sequence: number;
  created_at_ms: number;
  expires_at_ms: number;
};

export class AgentDeliveryCoordinatorRetryableError extends Error {
  readonly retryable = true;

  constructor(message: string) {
    super(message);
    this.name = 'AgentDeliveryCoordinatorRetryableError';
  }
}
