import {
  RETENTION_DAYS,
  buildStoredBodyKey,
  isEncryptedStoredBodiesPayload,
  type BodyEncryptionConfig,
  type StoredBodiesPayload,
  type SubscriptionTier,
} from '@trace-flow/types';
import type { Logger } from '@trace-flow/logging';
import { decryptStoredBodyPayload } from '@trace-flow/utils';

const MS_PER_DAY = 86_400_000;

function isStoredBodiesRecord(value: unknown): value is {
  requestBody?: unknown;
  responseBody?: unknown;
  truncated?: unknown;
} {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function resolveVisibilityWindowDays(tier?: SubscriptionTier): number {
  return RETENTION_DAYS[tier ?? 'hobby'];
}

export function isBodyVisible(uploaded: Date, tier?: SubscriptionTier, now = Date.now()): boolean {
  return uploaded.getTime() + resolveVisibilityWindowDays(tier) * MS_PER_DAY > now;
}

function parseStoredBodiesRecord(parsed: unknown, logger: Logger): StoredBodiesPayload {
  if (!isStoredBodiesRecord(parsed)) {
    throw new Error('Stored body payload must be an object');
  }

  let requestBody: string | null;
  if (parsed.requestBody === null || typeof parsed.requestBody === 'string') {
    requestBody = parsed.requestBody;
  } else {
    logger.warn('api.stored_bodies_unexpected_type', {
      field: 'requestBody',
      actualType: typeof parsed.requestBody,
    });
    requestBody = null;
  }

  let responseBody: string | null;
  if (parsed.responseBody === null || typeof parsed.responseBody === 'string') {
    responseBody = parsed.responseBody;
  } else {
    logger.warn('api.stored_bodies_unexpected_type', {
      field: 'responseBody',
      actualType: typeof parsed.responseBody,
    });
    responseBody = null;
  }

  return {
    requestBody,
    responseBody,
    ...(parsed.truncated === true ? { truncated: true } : {}),
  };
}

export function parseStoredBodiesPayload(raw: string, logger: Logger): StoredBodiesPayload {
  return parseStoredBodiesRecord(JSON.parse(raw), logger);
}

async function parsePossiblyEncryptedStoredBodiesPayload(
  raw: string,
  objectKey: string,
  orgId: string | undefined,
  encryption: BodyEncryptionConfig | undefined,
  logger: Logger,
): Promise<StoredBodiesPayload> {
  const parsed: unknown = JSON.parse(raw);

  if (!isEncryptedStoredBodiesPayload(parsed)) {
    logger.error('api.stored_bodies_plaintext_fallback', undefined, {
      objectKey,
      hasOrgId: Boolean(orgId),
    });
    return parseStoredBodiesRecord(parsed, logger);
  }

  if (!orgId) {
    throw new Error('Encrypted stored body missing org metadata');
  }

  if (parsed.orgId !== orgId) {
    throw new Error('Encrypted stored body org does not match object metadata');
  }

  if (!encryption?.rootKeyBase64) {
    throw new Error('Body encryption root key is not configured');
  }

  const decrypted = await decryptStoredBodyPayload(parsed, {
    rootKeyBase64: encryption.rootKeyBase64,
    keyId: encryption.keyId,
    orgId,
    objectKey,
  });

  return parseStoredBodiesPayload(decrypted, logger);
}

interface StoredBodiesResult {
  payload: StoredBodiesPayload;
  orgId?: string;
  uploaded: Date;
}

export async function getStoredBodies(
  storage: R2Bucket,
  requestId: string,
  logger: Logger,
  encryption?: BodyEncryptionConfig,
): Promise<StoredBodiesResult | null> {
  const objectKey = buildStoredBodyKey(requestId);
  const combinedObject = await storage.get(objectKey);

  if (!combinedObject) {
    return null;
  }

  try {
    const orgId = combinedObject.customMetadata?.orgId;
    return {
      payload: await parsePossiblyEncryptedStoredBodiesPayload(
        await combinedObject.text(),
        objectKey,
        orgId,
        encryption,
        logger,
      ),
      orgId,
      uploaded: combinedObject.uploaded,
    };
  } catch (error) {
    logger.error('api.stored_bodies_parse_failed', error, {
      requestId,
    });
    return null;
  }
}
