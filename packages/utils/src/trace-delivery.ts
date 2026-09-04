import type {
  TraceDeliveryEnvelope,
  TraceDeliveryMessage,
  TraceDeliveryPayload,
} from '@trace-flow/types';
import { buildStoredBodyKey, isEncryptedStoredBodiesPayload } from '@trace-flow/types';

export const TRACE_DELIVERY_PREFIX = 'trace-deliveries/';

export interface TraceDeliveryObject {
  json<T>(): Promise<T>;
}

export interface TraceDeliveryReader {
  get(key: string): Promise<TraceDeliveryObject | null>;
}

export interface TraceDeliveryCompleter {
  delete(key: string): Promise<void>;
}

export function buildTraceDeliveryKey(id: string): string {
  if (!id || id.includes('/') || id.includes('..')) {
    throw new Error('Trace delivery ID must be a non-empty path segment');
  }
  return `${TRACE_DELIVERY_PREFIX}${id}`;
}

export function isTraceDeliveryKey(key: string): boolean {
  if (!key.startsWith(TRACE_DELIVERY_PREFIX)) return false;
  const id = key.slice(TRACE_DELIVERY_PREFIX.length);
  return id.length > 0 && !id.includes('/') && !id.includes('..');
}

export function isTraceDeliveryMessage(value: unknown): value is TraceDeliveryMessage {
  if (!isRecord(value)) return false;
  return (
    value.type === 'delivery' && typeof value.key === 'string' && isTraceDeliveryKey(value.key)
  );
}

export function isTraceDeliveryEnvelope(value: unknown): value is TraceDeliveryEnvelope {
  if (!isRecord(value) || value.version !== 1 || !isDeliveryPayload(value.message)) return false;
  if (value.body === undefined) return true;
  if (value.message.type === 'otlp') return false;
  if (!isRecord(value.body)) return false;
  return (
    typeof value.body.key === 'string' &&
    value.body.key === buildStoredBodyKey(value.message.requestId) &&
    typeof value.body.orgId === 'string' &&
    value.body.orgId.length > 0 &&
    value.message.orgId === value.body.orgId &&
    isEncryptedStoredBodiesPayload(value.body.encryptedPayload) &&
    value.body.encryptedPayload.orgId === value.body.orgId
  );
}

export async function loadTraceDelivery(
  storage: TraceDeliveryReader,
  key: string,
): Promise<TraceDeliveryEnvelope | null> {
  if (!isTraceDeliveryKey(key)) throw new Error('Invalid trace delivery key');
  const object = await storage.get(key);
  if (!object) return null;
  const value: unknown = await object.json();
  if (!isTraceDeliveryEnvelope(value)) throw new Error(`Invalid trace delivery envelope: ${key}`);
  return value;
}

/** Delete only after every destination write represented by the envelope is durable. */
export async function completeTraceDelivery(
  storage: TraceDeliveryCompleter,
  key: string,
): Promise<void> {
  if (!isTraceDeliveryKey(key)) throw new Error('Invalid trace delivery key');
  await storage.delete(key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDeliveryPayload(value: unknown): value is TraceDeliveryPayload {
  if (!isRecord(value)) return false;
  if (value.type === 'otlp') {
    return typeof value.apiKey === 'string' && Array.isArray(value.traces);
  }
  return (
    (value.type === undefined || value.type === 'llm') &&
    typeof value.requestId === 'string' &&
    typeof value.apiKey === 'string' &&
    isRecord(value.request) &&
    isRecord(value.response) &&
    isRecord(value.timing)
  );
}
