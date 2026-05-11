import {
  buildStoredBodyKey,
  type BodyEncryptionConfig,
  type StoredBodiesPayload,
} from '@trace-flow/types';
import type { Logger } from '@trace-flow/logging';
import { encryptStoredBodyPayload } from '@trace-flow/utils';

/**
 * Stores request and response bodies in a single R2 object for later retrieval via the API worker.
 *
 * Key format: `bodies/{requestId}` (e.g., `bodies/abc-123`)
 * All stored bodies share the same physical retention policy. Access windows are
 * enforced when reading based on the caller's current subscription tier.
 *
 * Each request gets a unique requestId, ensuring bodies are never overwritten even when
 * multiple requests share the same parent trace ID for grouping.
 *
 * The request and response bodies are serialized into a single JSON payload to reduce
 * Class A operations in R2. This function is called within `waitUntil()` to avoid
 * blocking the client response.
 *
 * Returns storage success status to allow graceful degradation - queue message can still
 * be sent even if R2 storage fails.
 */
export async function storeBodies(
  storage: R2Bucket,
  requestId: string,
  requestBody: string,
  responseBody: string,
  truncated: boolean,
  logger: Logger,
  orgId?: string,
  encryption?: BodyEncryptionConfig,
): Promise<boolean> {
  const bodyKey = buildStoredBodyKey(requestId);

  if (!orgId || !encryption?.rootKeyBase64) {
    logger.error('proxy.r2_store_missing_encryption_context', undefined, {
      requestId,
      hasOrgId: Boolean(orgId),
      hasEncryptionKey: Boolean(encryption?.rootKeyBase64),
    });
    return false;
  }

  const payload: StoredBodiesPayload = {
    requestBody,
    responseBody,
    ...(truncated ? { truncated: true } : {}),
  };
  const putOptions: R2PutOptions = {
    customMetadata: { orgId },
    httpMetadata: { contentType: 'application/json' },
  };

  try {
    const encryptedPayload = await encryptStoredBodyPayload(JSON.stringify(payload), {
      rootKeyBase64: encryption.rootKeyBase64,
      keyId: encryption.keyId,
      orgId,
      objectKey: bodyKey,
    });

    await storage.put(bodyKey, JSON.stringify(encryptedPayload), putOptions);
    return true;
  } catch (error) {
    logger.error('proxy.r2_store_exception', error, {
      requestId,
    });
    return false;
  }
}
