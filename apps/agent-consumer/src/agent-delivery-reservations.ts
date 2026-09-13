import {
  AgentDeliveryCoordinatorRetryableError,
  MAX_AGENT_DIRTY_DAYS,
  type AgentDeliveryReservation,
  type ReserveAgentDeliveryInput,
  type StoredReservation,
} from './agent-delivery-coordinator-contract';
import {
  countPendingDirtyDays,
  findReservation,
  readDeliveryDays,
} from './agent-delivery-coordinator-storage';
import {
  assertExactKeys,
  sameStrings,
  validateDeliveryId,
  validatePayloadSha256,
} from './agent-delivery-coordinator-validation';

export function requireReservation(
  storage: DurableObjectStorage,
  input: { deliveryId: string; payloadSha256: string },
  operation: string,
): StoredReservation {
  assertExactKeys(input, ['deliveryId', 'payloadSha256'], operation);
  return requireStoredReservation(
    storage,
    validateDeliveryId(input.deliveryId),
    validatePayloadSha256(input.payloadSha256),
  );
}

export function requireStoredReservation(
  storage: DurableObjectStorage,
  deliveryId: string,
  payloadSha256: string,
): StoredReservation {
  const reservation = findReservation(storage, deliveryId);
  if (!reservation) throw new Error('unknown active delivery');
  if (reservation.payload_sha256 !== payloadSha256) {
    throw new Error('active delivery payload hash mismatch');
  }
  return reservation;
}

export function earliestDeliveryId(storage: DurableObjectStorage): string {
  return storage.sql
    .exec<{
      delivery_id: string;
    }>('SELECT delivery_id FROM active_deliveries ORDER BY delivery_sequence LIMIT 1')
    .one().delivery_id;
}

export function assertDirtyDayCapacity(storage: DurableObjectStorage): void {
  if (countPendingDirtyDays(storage) > MAX_AGENT_DIRTY_DAYS) {
    throw new AgentDeliveryCoordinatorRetryableError('dirty day limit reached');
  }
}

export function assertMatchingReservation(
  storage: DurableObjectStorage,
  existing: StoredReservation,
  requested: ReserveAgentDeliveryInput,
): void {
  if (existing.payload_sha256 !== requested.payloadSha256) {
    throw new Error('active delivery payload hash mismatch');
  }
  if (!sameStrings(readDeliveryDays(storage, existing.delivery_id), requested.dirtyDays)) {
    throw new Error('active delivery dirty days mismatch');
  }
  if (
    existing.created_at_ms !== requested.createdAtMs ||
    existing.expires_at_ms !== requested.expiresAtMs
  ) {
    throw new Error('active delivery retention metadata mismatch');
  }
}

export function toDeliveryReservation(
  storage: DurableObjectStorage,
  stored: StoredReservation,
): AgentDeliveryReservation {
  return {
    deliveryId: stored.delivery_id,
    payloadSha256: stored.payload_sha256,
    deliverySequence: stored.delivery_sequence,
    dirtyDays: readDeliveryDays(storage, stored.delivery_id),
    createdAtMs: stored.created_at_ms,
    expiresAtMs: stored.expires_at_ms,
  };
}
