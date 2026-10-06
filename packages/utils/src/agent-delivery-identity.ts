import type { AgentIngestQueueMessage } from '@trace-flow/types';
import { sha256Hex } from './crypto';

/** Stable JSON keeps object insertion order out of retry identity; array order remains meaningful. */
export function agentDeliveryCanonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    return Object.fromEntries(
      Object.entries(entry).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    );
  });
}

export async function agentDeliveryContentDigest(
  message: AgentIngestQueueMessage,
): Promise<string> {
  const { enqueued_at: _enqueuedAt, sentry_trace_context: _trace, ...content } = message;
  return sha256Hex(agentDeliveryCanonicalJson(content));
}

/** Retain the deployed v4 key shape while deriving its 122 identity bits from SHA-256. */
export async function agentDeliveryIdentityId(parts: readonly string[]): Promise<string> {
  const digest = await sha256Hex(JSON.stringify(parts));
  const variant = ((parseInt(digest[16]!, 16) & 3) | 8).toString(16);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

export async function agentDeliveryRetryKey(message: AgentIngestQueueMessage): Promise<string> {
  const id = await agentDeliveryIdentityId([
    'agent-delivery-retry-v1',
    message.tenancy.org_id,
    message.tenancy.collector_id,
    message.collector_batch_id,
    await agentDeliveryContentDigest(message),
  ]);
  return `agent-deliveries/${message.tenancy.org_id}/${id}`;
}
