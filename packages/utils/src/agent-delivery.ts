import type { R2Bucket } from '@cloudflare/workers-types';
import type {
  AgentDeliveryEnvelope,
  AgentDeliveryReference,
  AgentDeliveryStagedReference,
  AgentIngestQueueMessage,
  BodyEncryptionConfig,
} from '@trace-flow/types';
import {
  AGENT_INGEST_LIMITS,
  isEncryptedStoredBodiesPayload,
  validateAgentIngestQueueMessage,
} from '@trace-flow/types';
import { decryptStoredBodyPayload, encryptStoredBodyPayload, sha256Hex } from './crypto';

export const AGENT_DELIVERY_PREFIX = 'agent-deliveries/';
export const MAX_AGENT_DELIVERY_AGE_MS = 4 * 24 * 60 * 60 * 1_000;
export const MAX_AGENT_DELIVERY_CLOCK_SKEW_MS = 60 * 1_000;
export const MAX_AGENT_DELIVERY_PLAINTEXT_BYTES = 128 * 1024;
export const MAX_AGENT_DELIVERY_OBJECT_BYTES = 192 * 1024;

const DELIVERY_KEY_PATTERN =
  /^agent-deliveries\/[a-zA-Z0-9_-]{1,256}\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const encoder = new TextEncoder();

type RequiredBodyEncryption = BodyEncryptionConfig & { rootKeyBase64: string };

export class AgentDeliveryError extends Error {
  constructor(readonly code: string) {
    super(`Invalid agent delivery: ${code}`);
    this.name = 'AgentDeliveryError';
  }
}

export interface StageAgentDeliveryOptions {
  storage: R2Bucket;
  message: AgentIngestQueueMessage;
  encryption: RequiredBodyEncryption;
  now?: number;
}

export interface LoadAgentDeliveryOptions {
  storage: R2Bucket;
  reference: AgentDeliveryReference;
  encryption: RequiredBodyEncryption;
  now?: number;
}

export function validateAgentDeliveryReference(value: unknown): string | null {
  const baseError = validateReferenceBase(value, true);
  if (baseError) return baseError;
  if (!isRecord(value) || !isPositiveSafeInteger(value.delivery_revision)) {
    return 'delivery_revision';
  }
  return null;
}

export function validateAgentDeliveryStagedReference(value: unknown): string | null {
  return validateReferenceBase(value, false);
}

function validateReferenceBase(value: unknown, includeRevision: boolean): string | null {
  if (!isRecord(value)) return 'reference';
  const allowed = new Set([
    'type',
    'version',
    'key',
    'org_id',
    'sha256',
    'created_at',
    'expires_at',
  ]);
  if (includeRevision) allowed.add('delivery_revision');
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) return unknown;
  if (value.type !== 'agent-delivery') return 'type';
  if (value.version !== 1) return 'version';
  if (typeof value.key !== 'string' || !DELIVERY_KEY_PATTERN.test(value.key)) return 'key';
  if (
    typeof value.org_id !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,256}$/.test(value.org_id) ||
    byteLength(value.org_id) > AGENT_INGEST_LIMITS.maxIdentifierBytes
  ) {
    return 'org_id';
  }
  if (!value.key.startsWith(`${AGENT_DELIVERY_PREFIX}${value.org_id}/`)) return 'key_org';
  if (typeof value.sha256 !== 'string' || !SHA256_PATTERN.test(value.sha256)) return 'sha256';
  if (!isTimestamp(value.created_at)) return 'created_at';
  if (!isTimestamp(value.expires_at)) return 'expires_at';
  if (value.expires_at <= value.created_at) return 'expires_at';
  if (value.expires_at - value.created_at > MAX_AGENT_DELIVERY_AGE_MS) return 'expires_at';
  return null;
}

export function isAgentDeliveryReference(value: unknown): value is AgentDeliveryReference {
  return validateAgentDeliveryReference(value) === null;
}

export function isAgentDeliveryStagedReference(
  value: unknown,
): value is AgentDeliveryStagedReference {
  return validateAgentDeliveryStagedReference(value) === null;
}

export async function stageAgentDelivery(
  options: StageAgentDeliveryOptions,
): Promise<AgentDeliveryStagedReference> {
  const queueError = validateAgentIngestQueueMessage(options.message);
  if (queueError) throw new AgentDeliveryError(`queue_message.${queueError}`);

  if (!/^[a-zA-Z0-9_-]{1,256}$/.test(options.message.tenancy.org_id)) {
    throw new AgentDeliveryError('org_id');
  }
  const plaintext = JSON.stringify(options.message);
  if (byteLength(plaintext) > MAX_AGENT_DELIVERY_PLAINTEXT_BYTES) {
    throw new AgentDeliveryError('plaintext_too_large');
  }

  const createdAt = options.now ?? Date.now();
  if (!isTimestamp(createdAt)) throw new AgentDeliveryError('created_at');
  const expiresAt = createdAt + MAX_AGENT_DELIVERY_AGE_MS;
  if (!isTimestamp(expiresAt)) throw new AgentDeliveryError('expires_at');
  const key = `${AGENT_DELIVERY_PREFIX}${options.message.tenancy.org_id}/${crypto.randomUUID()}`;
  const sha256 = await sha256Hex(plaintext);
  const encryptedPayload = await encryptStoredBodyPayload(plaintext, {
    ...options.encryption,
    orgId: options.message.tenancy.org_id,
    objectKey: key,
  });
  const envelope: AgentDeliveryEnvelope = {
    version: 1,
    created_at: createdAt,
    expires_at: expiresAt,
    sha256,
    encryptedPayload,
  };
  const serialized = JSON.stringify(envelope);
  if (byteLength(serialized) > MAX_AGENT_DELIVERY_OBJECT_BYTES) {
    throw new AgentDeliveryError('object_too_large');
  }

  const stored = await options.storage.put(key, serialized, {
    onlyIf: { etagDoesNotMatch: '*' },
    httpMetadata: { contentType: 'application/json' },
    customMetadata: {
      orgId: options.message.tenancy.org_id,
      expiresAt: String(expiresAt),
    },
  });
  if (!stored) throw new AgentDeliveryError('key_collision');

  return {
    type: 'agent-delivery',
    version: 1,
    key,
    org_id: options.message.tenancy.org_id,
    sha256,
    created_at: createdAt,
    expires_at: expiresAt,
  };
}

export async function loadAgentDelivery(
  options: LoadAgentDeliveryOptions,
): Promise<AgentIngestQueueMessage> {
  const referenceError = validateAgentDeliveryReference(options.reference);
  if (referenceError) throw new AgentDeliveryError(`reference.${referenceError}`);
  const now = options.now ?? Date.now();
  if (options.reference.created_at > now + MAX_AGENT_DELIVERY_CLOCK_SKEW_MS) {
    throw new AgentDeliveryError('created_in_future');
  }
  if (options.reference.expires_at <= now) throw new AgentDeliveryError('expired');

  const object = await options.storage.get(options.reference.key);
  if (!object) throw new AgentDeliveryError('not_found');
  if (object.size > MAX_AGENT_DELIVERY_OBJECT_BYTES) {
    throw new AgentDeliveryError('object_too_large');
  }
  const serialized = await object.text();
  if (byteLength(serialized) > MAX_AGENT_DELIVERY_OBJECT_BYTES) {
    throw new AgentDeliveryError('object_too_large');
  }

  const envelope = parseEnvelope(serialized);
  if (
    envelope.created_at !== options.reference.created_at ||
    envelope.expires_at !== options.reference.expires_at ||
    envelope.sha256 !== options.reference.sha256
  ) {
    throw new AgentDeliveryError('reference_mismatch');
  }
  if (envelope.encryptedPayload.orgId !== options.reference.org_id) {
    throw new AgentDeliveryError('tenant_mismatch');
  }

  let plaintext: string;
  try {
    plaintext = await decryptStoredBodyPayload(envelope.encryptedPayload, {
      ...options.encryption,
      orgId: options.reference.org_id,
      objectKey: options.reference.key,
    });
  } catch {
    throw new AgentDeliveryError('decryption_failed');
  }
  if (byteLength(plaintext) > MAX_AGENT_DELIVERY_PLAINTEXT_BYTES) {
    throw new AgentDeliveryError('plaintext_too_large');
  }
  if ((await sha256Hex(plaintext)) !== options.reference.sha256) {
    throw new AgentDeliveryError('hash_mismatch');
  }

  let message: unknown;
  try {
    message = JSON.parse(plaintext) as unknown;
  } catch {
    throw new AgentDeliveryError('invalid_payload');
  }
  const queueError = validateAgentIngestQueueMessage(message);
  if (queueError) throw new AgentDeliveryError(`queue_message.${queueError}`);
  if ((message as AgentIngestQueueMessage).tenancy.org_id !== options.reference.org_id) {
    throw new AgentDeliveryError('tenant_mismatch');
  }
  return message as AgentIngestQueueMessage;
}

function parseEnvelope(serialized: string): AgentDeliveryEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    throw new AgentDeliveryError('invalid_envelope');
  }
  if (!isRecord(value)) throw new AgentDeliveryError('invalid_envelope');
  const allowed = new Set(['version', 'created_at', 'expires_at', 'sha256', 'encryptedPayload']);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new AgentDeliveryError('invalid_envelope');
  }
  if (
    value.version !== 1 ||
    !isTimestamp(value.created_at) ||
    !isTimestamp(value.expires_at) ||
    typeof value.sha256 !== 'string' ||
    !SHA256_PATTERN.test(value.sha256) ||
    !isEncryptedStoredBodiesPayload(value.encryptedPayload)
  ) {
    throw new AgentDeliveryError('invalid_envelope');
  }
  return {
    version: 1,
    created_at: value.created_at,
    expires_at: value.expires_at,
    sha256: value.sha256,
    encryptedPayload: value.encryptedPayload,
  };
}

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
