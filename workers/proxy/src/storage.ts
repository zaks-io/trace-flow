/**
 * Stores request and response bodies in R2 for later processing by the queue consumer.
 * Uses a consistent key naming convention (`requests/{id}`, `responses/{id}`) that the consumer relies on.
 *
 * Uploads both bodies in parallel to minimize latency, since they're independent operations.
 * This function is called within `waitUntil()` to avoid blocking the client response.
 */
export async function storeRequestResponse(
  storage: R2Bucket,
  requestId: string,
  requestBody: string,
  responseBody: string,
): Promise<{ requestBodyKey: string; responseBodyKey: string }> {
  const requestBodyKey = `requests/${requestId}`;
  const responseBodyKey = `responses/${requestId}`;

  console.log('Storing request/response bodies in R2:', {
    requestId,
    requestBodyKey,
    responseBodyKey,
    requestBodySize: requestBody.length,
    responseBodySize: responseBody.length,
  });

  await Promise.all([
    storage.put(requestBodyKey, requestBody),
    storage.put(responseBodyKey, responseBody),
  ]);

  console.log('Successfully stored in R2:', {
    requestId,
  });

  return { requestBodyKey, responseBodyKey };
}
