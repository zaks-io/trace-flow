import { tracing } from 'cloudflare:workers';
import type { SentryTraceContext } from '@trace-flow/types';
import {
  captureSafeException,
  continueQueueTrace,
  durableSentryTraceHeader,
} from '@trace-flow/utils/sentry-tracing';
import { withNativeTrace } from '@trace-flow/utils/native-tracing';
import type { AgentConsumerEnv } from './context';
import { runAgentSnapshot } from './snapshot-runner';

export const AGENT_SNAPSHOT_QUEUE_NAMES = new Set(['agent-snapshot-dev', 'agent-snapshot-prod']);

export async function processSnapshotQueue(
  batch: MessageBatch<unknown>,
  env: AgentConsumerEnv,
): Promise<void> {
  for (const message of batch.messages) {
    const body = message.body as {
      type?: unknown;
      org_id?: unknown;
      sentry_trace_context?: SentryTraceContext;
    } | null;
    const traceHeader = durableSentryTraceHeader(body?.sentry_trace_context);
    await continueQueueTrace(
      traceHeader ? { 'sentry-trace': traceHeader } : undefined,
      { queueName: batch.queue, messageCount: 1 },
      () =>
        withNativeTrace(tracing, 'trace_flow.agent_snapshot', async () => {
          try {
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
            captureSafeException(error, {
              message: 'Agent snapshot processing failed',
              operation: 'agent_snapshot',
            });
            message.retry({ delaySeconds: 60 });
          }
        }),
    );
  }
}
