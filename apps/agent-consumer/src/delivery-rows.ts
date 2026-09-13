import type { AgentIngestQueueMessage, EncryptedStoredBodiesPayload } from '@trace-flow/types';
import { decryptStoredBodyPayload, encryptStoredBodyPayload, sha256Hex } from '@trace-flow/utils';
import { accumulateMessage } from './consumer';
import {
  CATEGORIES,
  ROW_IDENTITY_FIELDS,
  emptyAccumulator,
  factPartitionKey,
  rowIdentity,
  type Accumulator,
} from './facts';
import { PriceCache } from './pricing';

const MAX_PRICED_DELIVERY_BYTES = 1024 * 1024;
const MAX_ENCRYPTED_PRICED_DELIVERY_BYTES = 1500 * 1024;

export interface DeliveryRows {
  orgId: string;
  revision: number;
  expiresAt: number;
  rows: Accumulator;
}

interface DeliveryRowsStorage {
  AGENT_DELIVERIES: R2Bucket;
  BODY_ENCRYPTION_ROOT_KEY: string;
}

export async function priceDelivery(
  message: AgentIngestQueueMessage,
  revision: number,
  expiresAt: number,
  pricing: KVNamespace,
): Promise<DeliveryRows> {
  const rows = emptyAccumulator();
  await accumulateMessage(message, rows, new PriceCache(pricing));
  return versionDeliveryRows(rows, {
    orgId: message.tenancy.org_id,
    revision,
    expiresAt,
  });
}

export async function versionDeliveryRows(
  rows: Accumulator,
  contract: Omit<DeliveryRows, 'rows'>,
): Promise<DeliveryRows> {
  if (!Number.isSafeInteger(contract.revision) || contract.revision <= 0) {
    throw new Error('Invalid delivery revision');
  }
  if (!Number.isSafeInteger(contract.expiresAt) || contract.expiresAt <= 0) {
    throw new Error('Invalid delivery expiry');
  }
  const versionedRows = emptyAccumulator();
  for (const category of CATEGORIES) {
    const unique = new Map<string, Record<string, unknown>>();
    for (const value of rows[category]) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`Invalid ${category} delivery row`);
      }
      const row = value as Record<string, unknown>;
      if (row.OrgId !== contract.orgId) throw new Error(`Invalid ${category} row organization`);
      for (const field of ROW_IDENTITY_FIELDS[category]) {
        if (typeof row[field] !== 'string' || row[field].length === 0) {
          throw new Error(`Invalid ${category} row identity`);
        }
      }
      const identity = rowIdentity(row, ROW_IDENTITY_FIELDS[category]);
      // Validate the partition timestamp before any Tinybird lookup or write uses this row.
      void factPartitionKey(category, row);
      const versioned: Record<string, unknown> = {
        ...row,
        DeliverySequence: contract.revision,
        IsDeleted: 0,
      };
      delete versioned.ContentHash;
      const hash = await sha256Hex(JSON.stringify(versioned));
      const previous = unique.get(identity);
      if (previous && previous.ContentHash !== hash) {
        throw new Error(`Conflicting ${category} identities in one delivery`);
      }
      unique.set(identity, { ...versioned, ContentHash: hash });
    }
    versionedRows[category] = [...unique.values()];
  }
  return { ...contract, rows: versionedRows };
}

export async function storeDeliveryRows(
  env: DeliveryRowsStorage,
  key: string,
  delivery: DeliveryRows,
): Promise<string> {
  return persistDeliveryRows(env, key, delivery, false);
}

/** Create an immutable recovery source, accepting an exact prior write for idempotent retries. */
export async function storeDeliveryRowsOnce(
  env: DeliveryRowsStorage,
  key: string,
  delivery: DeliveryRows,
): Promise<string> {
  return persistDeliveryRows(env, key, delivery, true);
}

async function persistDeliveryRows(
  env: DeliveryRowsStorage,
  key: string,
  delivery: DeliveryRows,
  immutable: boolean,
): Promise<string> {
  const plaintext = JSON.stringify(delivery);
  if (new TextEncoder().encode(plaintext).byteLength > MAX_PRICED_DELIVERY_BYTES) {
    throw new Error('Priced delivery exceeds storage limit');
  }
  const encrypted = await encryptStoredBodyPayload(plaintext, {
    rootKeyBase64: env.BODY_ENCRYPTION_ROOT_KEY,
    orgId: delivery.orgId,
    objectKey: key,
  });
  const sha256 = await sha256Hex(plaintext);
  const result = await env.AGENT_DELIVERIES.put(key, JSON.stringify(encrypted), {
    ...(immutable ? { onlyIf: { etagDoesNotMatch: '*' } } : {}),
    customMetadata: { expiresAt: String(delivery.expiresAt) },
    httpMetadata: { contentType: 'application/json' },
  });
  if (!result) {
    await loadDeliveryRows(env, key, {
      orgId: delivery.orgId,
      revision: delivery.revision,
      expiresAt: delivery.expiresAt,
      sha256,
    });
  }
  return sha256;
}

export async function loadDeliveryRows(
  env: DeliveryRowsStorage,
  key: string,
  expected: { orgId: string; revision: number; expiresAt: number; sha256: string },
): Promise<DeliveryRows> {
  if (Date.now() >= expected.expiresAt) throw new Error('Priced delivery expired');
  const object = await env.AGENT_DELIVERIES.get(key);
  if (!object) throw new Error('Priced delivery is missing');
  if (object.size > MAX_ENCRYPTED_PRICED_DELIVERY_BYTES) {
    throw new Error('Encrypted priced delivery exceeds storage limit');
  }
  const encrypted = await object.json<EncryptedStoredBodiesPayload>();
  const plaintext = await decryptStoredBodyPayload(encrypted, {
    rootKeyBase64: env.BODY_ENCRYPTION_ROOT_KEY,
    orgId: expected.orgId,
    objectKey: key,
  });
  if (
    new TextEncoder().encode(plaintext).byteLength > MAX_PRICED_DELIVERY_BYTES ||
    (await sha256Hex(plaintext)) !== expected.sha256
  ) {
    throw new Error('Priced delivery integrity check failed');
  }
  const delivery = JSON.parse(plaintext) as DeliveryRows;
  if (
    delivery.orgId !== expected.orgId ||
    delivery.revision !== expected.revision ||
    delivery.expiresAt !== expected.expiresAt ||
    CATEGORIES.some((category) => !Array.isArray(delivery.rows?.[category]))
  ) {
    throw new Error('Priced delivery contract mismatch');
  }
  return delivery;
}
