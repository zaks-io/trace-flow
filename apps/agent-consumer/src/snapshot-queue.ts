import * as Sentry from '@sentry/cloudflare';
import type { AgentConsumerEnv } from './context';
import { runAgentSnapshot } from './snapshot-runner';

export const AGENT_SNAPSHOT_QUEUE_NAMES = new Set(['agent-snapshot-dev', 'agent-snapshot-prod']);

export async function processSnapshotQueue(
  batch: MessageBatch<unknown>,
  env: AgentConsumerEnv,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      const body = message.body as { type?: unknown; org_id?: unknown } | null;
      if (
        body?.type !== 'agent-snapshot' ||
        typeof body.org_id !== 'string' ||
        !body.org_id ||
        body.org_id.length > 256 ||
        body.org_id.includes(':')
      ) {
        throw new Error('Invalid agent snapshot queue message');
      }
      const result = await runAgentSnapshot(env, body.org_id);
      if (result.status === 'retry') message.retry({ delaySeconds: 60 });
      else message.ack();
    } catch (error) {
      Sentry.captureException(error, { tags: { operation: 'agent_snapshot' } });
      message.retry({ delaySeconds: 60 });
    }
  }
}
