import type { StoredBodiesPayload } from '@trace-flow/types';

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
  orgId?: string,
): Promise<boolean> {
  const payload: StoredBodiesPayload = {
    requestBody,
    responseBody,
    ...(truncated ? { truncated: true } : {}),
  };
  const putOptions: R2PutOptions = {
    ...(orgId ? { customMetadata: { orgId } } : {}),
    httpMetadata: { contentType: 'application/json' },
  };

  try {
    await storage.put(`bodies/${requestId}`, JSON.stringify(payload), putOptions);
    return true;
  } catch (error) {
    console.error('Failed to store in R2:', {
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
