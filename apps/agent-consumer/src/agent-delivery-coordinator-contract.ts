import { MAX_AGENT_ANALYTICS_DAY_BUCKETS } from '@trace-flow/utils';
export const MAX_ACTIVE_AGENT_DELIVERIES = 64;
export const MAX_AGENT_DIRTY_DAYS = MAX_AGENT_ANALYTICS_DAY_BUCKETS;
export const MAX_AGENT_DELIVERY_RETENTION_MS = 4 * 24 * 60 * 60 * 1000;
export const MAX_AGENT_SNAPSHOT_LEASE_MS = 5 * 60 * 1000;
export const MAX_AGENT_SNAPSHOT_DAYS = 7;
export const MAX_AGENT_SNAPSHOT_COPY_DAYS = 31;
export const MAX_AGENT_SNAPSHOT_COPY_CHUNKS = 12;
export const AGENT_SNAPSHOT_COPY_ATTEMPT_MULTIPLIER = 16;
export const MAX_AGENT_DIRTY_DAY_LINK_NODES = MAX_AGENT_ANALYTICS_DAY_BUCKETS;
export const MAX_AGENT_DIRTY_DAY_LINKS =
  (MAX_AGENT_DIRTY_DAY_LINK_NODES * (MAX_AGENT_DIRTY_DAY_LINK_NODES - 1)) / 2;

export function isAgentSnapshotCopyAttempt(generation: number, copyAttempt: number): boolean {
  if (
    !Number.isSafeInteger(generation) ||
    generation <= 0 ||
    !Number.isSafeInteger(copyAttempt) ||
    copyAttempt <= 0
  ) {
    return false;
  }
  if (copyAttempt === generation) return true;
  const firstChunkAttempt = generation * AGENT_SNAPSHOT_COPY_ATTEMPT_MULTIPLIER;
  return (
    Number.isSafeInteger(firstChunkAttempt) &&
    copyAttempt >= firstChunkAttempt &&
    copyAttempt - firstChunkAttempt < MAX_AGENT_SNAPSHOT_COPY_CHUNKS
  );
}

export interface ReserveAgentDeliveryInput {
  deliveryId: string;
  payloadSha256: string;
  dirtyDays: string[];
  createdAtMs: number;
  expiresAtMs: number;
}

export interface AgentDirtyDayLink {
  oldDay: string;
  newDay: string;
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

export interface AgentSnapshotProgress extends BeginAgentSnapshotResult {
  nextCopyIndex: number;
  totalCopies: number;
  claimId: string;
  claimExpiresAtMs: number;
  manifestPublishedAtMs?: number;
}

export interface AgentDeliveryCoordinatorStats {
  lastDeliverySequence: number;
  lastSnapshotGeneration: number;
  activeDeliveries: number;
  dirtyDays: number;
  incompleteDays: number;
  dirtyDayLinks: number;
  capturedSnapshotDays: number;
  gatePhase: 'open' | 'draining' | 'snapshot';
  activeSnapshotGeneration: number | null;
  gateExpiresAtMs: number | null;
  erasureStarted: boolean;
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
