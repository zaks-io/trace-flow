import { agentAnalyticsDayBounds } from '@trace-flow/utils';
import {
  MAX_AGENT_DELIVERY_RETENTION_MS,
  MAX_AGENT_DIRTY_DAYS,
  type ReserveAgentDeliveryInput,
} from './agent-delivery-coordinator-contract';

export function validateReservationInput(
  input: ReserveAgentDeliveryInput,
): ReserveAgentDeliveryInput {
  assertExactKeys(
    input,
    ['createdAtMs', 'deliveryId', 'dirtyDays', 'expiresAtMs', 'payloadSha256'],
    'reserve delivery',
  );
  return {
    deliveryId: validateDeliveryId(input.deliveryId),
    payloadSha256: validatePayloadSha256(input.payloadSha256),
    dirtyDays: validateDaySet(input.dirtyDays, 'delivery dirtyDays'),
    createdAtMs: validateTimestamp(input.createdAtMs, 'delivery createdAtMs'),
    expiresAtMs: validateTimestamp(input.expiresAtMs, 'delivery expiresAtMs'),
  };
}

export function assertNewReservationWindow(
  reservation: ReserveAgentDeliveryInput,
  now: number,
): void {
  if (reservation.createdAtMs > now)
    throw new Error('delivery createdAtMs cannot be in the future');
  if (reservation.expiresAtMs <= now) throw new Error('delivery expiresAtMs must be in the future');
  if (reservation.expiresAtMs <= reservation.createdAtMs) {
    throw new Error('delivery expiresAtMs must be after createdAtMs');
  }
  if (reservation.expiresAtMs - reservation.createdAtMs > MAX_AGENT_DELIVERY_RETENTION_MS) {
    throw new Error('delivery retention exceeds four days');
  }
  assertRetainedDaySet(reservation.dirtyDays, now);
}

export function assertRetainedDaySet(dirtyDays: string[], now: number): void {
  const { oldestDirtyDay, todayDirtyDay } = retainedDayBounds(now);
  for (const dirtyDay of dirtyDays) {
    if (dirtyDay < oldestDirtyDay || dirtyDay > todayDirtyDay) {
      throw new Error('dirty day is outside the retained fact window');
    }
  }
}

export function retainedDayBounds(now: number): {
  oldestDirtyDay: string;
  todayDirtyDay: string;
} {
  const { oldestDay, today } = agentAnalyticsDayBounds(now);
  return { oldestDirtyDay: oldestDay, todayDirtyDay: today };
}

export function validateDeliveryId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    value.trim() !== value ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    throw new Error('deliveryId must be a non-empty printable string of at most 256 characters');
  }
  return value;
}

export function validatePayloadSha256(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error('payloadSha256 must be 64 lowercase hexadecimal characters');
  }
  return value;
}

export function validateDaySet(value: unknown, label: string): string[] {
  const days = validateCalendarDaySet(value, label);
  if (days.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
  return days;
}

export function validateDeliveryPlanDays(value: unknown): string[] {
  return validateCalendarDaySet(value, 'delivery plan dirtyDays');
}

function validateCalendarDaySet(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (value.length > MAX_AGENT_DIRTY_DAYS) throw new Error(`${label} has too many days`);
  return [...new Set(value.map(validateCalendarDay))].sort();
}

function validateCalendarDay(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error('dirty day must use YYYY-MM-DD');
  }
  const dayMs = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(dayMs) || new Date(dayMs).toISOString().slice(0, 10) !== value) {
    throw new Error('dirty day is not a calendar date');
  }
  return value;
}

function validateTimestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

export function validateGenerationInput(input: { generation: number }, operation: string): number {
  assertExactKeys(input, ['generation'], operation);
  if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
    throw new Error('snapshot generation must be a positive safe integer');
  }
  return input.generation;
}

export function assertExactKeys(
  value: unknown,
  expected: string[],
  operation: string,
): asserts value is object {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${operation} input must be an object`);
  }
  const keys = Object.keys(value).sort();
  if (!sameStrings(keys, [...expected].sort())) {
    throw new Error(`${operation} input has unexpected fields`);
  }
}

export function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
