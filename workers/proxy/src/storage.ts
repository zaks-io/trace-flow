import type { SubscriptionTier } from '@trace-flow/types';

/**
 * Stores request and response bodies in R2 for later retrieval via the API worker.
 *
 * Key format: `{type}s/{tier}/{requestId}` (e.g., `requests/hobby/abc-123`)
 * This enables R2 lifecycle rules to automatically delete bodies based on tier:
 * - hobby: 7-day retention
 * - pro: 30-day retention
 *
 * When tier is unknown, defaults to 'hobby' for conservative retention.
 *
 * Each request gets a unique requestId, ensuring bodies are never overwritten even when
 * multiple requests share the same parent trace ID for grouping.
 *
 * Uploads both bodies in parallel to minimize latency, since they're independent operations.
 * This function is called within `waitUntil()` to avoid blocking the client response.
 *
 * Returns storage success status to allow graceful degradation - queue message can still be sent
 * even if R2 storage fails (consumer will handle missing bodies).
 */
export async function storeRequestResponse(
  storage: R2Bucket,
  requestId: string,
  requestBody: string,
  responseBody: string,
  tier?: SubscriptionTier,
): Promise<{ requestBodyKey: string; responseBodyKey: string; stored: boolean }> {
  // Default to 'hobby' for unknown tiers (conservative retention)
  const tierPrefix = tier ?? 'hobby';
  const requestBodyKey = `requests/${tierPrefix}/${requestId}`;
  const responseBodyKey = `responses/${tierPrefix}/${requestId}`;

  try {
    await Promise.all([
      storage.put(requestBodyKey, requestBody),
      storage.put(responseBodyKey, responseBody),
    ]);

    return { requestBodyKey, responseBodyKey, stored: true };
  } catch (error) {
    console.error('Failed to store in R2:', {
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });

    return { requestBodyKey, responseBodyKey, stored: false };
  }
}
