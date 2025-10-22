/**
 * Stores request and response bodies in R2 for later processing by the queue consumer.
 * Uses a consistent key naming convention (`requests/{id}`, `responses/{id}`) that the consumer relies on.
 *
 * Uploads both bodies in parallel to minimize latency, since they're independent operations.
 * This function is called within `waitUntil()` to avoid blocking the client response.
 *
 * Returns storage success status to allow graceful degradation - queue message can still be sent
 * even if R2 storage fails (consumer will handle missing bodies).
 */
export async function storeRequestResponse(
  storage: R2Bucket,
  traceId: string,
  requestBody: string,
  responseBody: string,
): Promise<{ requestBodyKey: string; responseBodyKey: string; stored: boolean }> {
  const requestBodyKey = `requests/${traceId}`;
  const responseBodyKey = `responses/${traceId}`;

  console.log('Storing request/response bodies in R2:', {
    traceId,
    requestBodyKey,
    responseBodyKey,
    requestBodySize: requestBody.length,
    responseBodySize: responseBody.length,
  });

  try {
    await Promise.all([
      storage.put(requestBodyKey, requestBody),
      storage.put(responseBodyKey, responseBody),
    ]);

    console.log('Successfully stored in R2:', {
      traceId,
    });

    return { requestBodyKey, responseBodyKey, stored: true };
  } catch (error) {
    console.error('Failed to store in R2:', {
      traceId,
      error: error instanceof Error ? error.message : String(error),
    });

    return { requestBodyKey, responseBodyKey, stored: false };
  }
}
