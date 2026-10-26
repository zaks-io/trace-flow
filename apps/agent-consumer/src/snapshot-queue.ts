import { tracing } from 'cloudflare:workers';
import type { SentryTraceContext } from '@trace-flow/types';
import { continueQueueTrace, durableSentryTraceHeader } from '@trace-flow/utils/sentry-tracing';
import { withNativeTrace } from '@trace-flow/utils/native-tracing';
import type { AgentConsumerEnv } from './context';
import { runAgentSnapshot } from './snapshot-runner';
import { captureSnapshotException } from './snapshot-diagnostics';
import { getActiveSpan } from '@sentry/cloudflare';

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
          let orgId: string | undefined;
          try {
            getActiveSpan()?.setAttribute('messaging.message.retry.count', message.attempts - 1);
            if (
              body?.type !== 'agent-snapshot' ||
              typeof body.org_id !== 'string' ||
              !body.org_id ||
              body.org_id.length > 256 ||
              body.org_id.includes(':')
            ) {
              throw new Error('Invalid agent snapshot queue message');
            }
            orgId = body.org_id;
            const result = await runAgentSnapshot(env, orgId);
            getActiveSpan()?.setAttributes({
              'trace_flow.snapshot.result': result.status,
              'trace_flow.snapshot.reason': 'reason' in result ? result.reason : undefined,
              'trace_flow.snapshot.copy_index':
                'nextCopyIndex' in result ? result.nextCopyIndex : undefined,
              'trace_flow.snapshot.generation':
                'generation' in result ? result.generation : undefined,
            });
            if (result.status === 'retry') message.retry({ delaySeconds: 60 });
            else message.ack();
          } catch (error) {
            getActiveSpan()?.setAttribute('trace_flow.snapshot.result', 'error');
            captureSnapshotException(error, { stage: 'dispatch', orgId });
            message.retry({ delaySeconds: 60 });
          }
        }),
    );
  }
}
