/**
 * Stores request and response bodies in R2 for later retrieval via the API worker.
 * Uses a consistent key naming convention (`requests/{requestId}`, `responses/{requestId}`).
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
): Promise<{ requestBodyKey: string; responseBodyKey: string; stored: boolean }> {
  const requestBodyKey = `requests/${requestId}`;
  const responseBodyKey = `responses/${requestId}`;

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
