import { agentDeliveryIdentityId, MAX_AGENT_DELIVERY_AGE_MS } from '@trace-flow/utils';

export class CollectorBatchConflictError extends Error {
  constructor() {
    super('Collector batch identity was reused with conflicting or expired content');
    this.name = 'CollectorBatchConflictError';
  }
}

interface RequestManifest {
  version: 1;
  request_digest: string;
  created_at: number;
  expires_at: number;
}

/** A small conditional record fences conflicting retries before any ownership claim. */
export async function recordCollectorRequest(
  storage: R2Bucket,
  orgId: string,
  collectorId: string,
  request: { batchId: string; digest: string },
  now: number,
): Promise<void> {
  const id = await agentDeliveryIdentityId([
    'agent-request-retry-v1',
    orgId,
    collectorId,
    request.batchId,
  ]);
  const key = `agent-deliveries/${orgId}/requests/${id}`;
  const manifest: RequestManifest = {
    version: 1,
    request_digest: request.digest,
    created_at: now,
    expires_at: now + MAX_AGENT_DELIVERY_AGE_MS,
  };
  const stored = await storage.put(key, JSON.stringify(manifest), {
    onlyIf: { etagDoesNotMatch: '*' },
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { orgId, expiresAt: String(manifest.expires_at) },
  });
  if (stored) return;
  const existing = await storage.get(key);
  if (!existing || existing.size > 1024) throw new CollectorBatchConflictError();
  const original = await existing.json<RequestManifest>();
  if (
    original.version !== 1 ||
    original.request_digest !== request.digest ||
    !Number.isSafeInteger(original.created_at) ||
    !Number.isSafeInteger(original.expires_at) ||
    original.created_at > now ||
    original.expires_at <= now ||
    original.expires_at - original.created_at !== MAX_AGENT_DELIVERY_AGE_MS
  ) {
    throw new CollectorBatchConflictError();
  }
}
