import {
  RETENTION_DAYS,
  buildStoredBodyKey,
  type StoredBodiesPayload,
  type SubscriptionTier,
} from '@trace-flow/types';
import type { Logger } from '@trace-flow/logging';

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

export function parseStoredBodiesPayload(raw: string, logger: Logger): StoredBodiesPayload {
  const parsed: unknown = JSON.parse(raw);

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

interface StoredBodiesResult {
  payload: StoredBodiesPayload;
  orgId?: string;
  uploaded: Date;
}

export async function getStoredBodies(
  storage: R2Bucket,
  requestId: string,
  logger: Logger,
): Promise<StoredBodiesResult | null> {
  const combinedObject = await storage.get(buildStoredBodyKey(requestId));

  if (!combinedObject) {
    return null;
  }

  try {
    return {
      payload: parseStoredBodiesPayload(await combinedObject.text(), logger),
      orgId: combinedObject.customMetadata?.orgId,
      uploaded: combinedObject.uploaded,
    };
  } catch (error) {
    logger.error('api.stored_bodies_parse_failed', error, {
      requestId,
    });
    return null;
  }
}
