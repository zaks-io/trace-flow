export interface StoredBodiesPayload {
  requestBody: string | null;
  responseBody: string | null;
  truncated?: boolean;
}

export function buildStoredBodyKey(requestId: string): string {
  return `bodies/${requestId}`;
}
