import { sentryRequestPrivacy } from '@trace-flow/utils/sentry-tracing';
/**
 * Queue entrypoint for encrypted fact deliveries and published analytics snapshots.
 * See docs/adr/0024-bounded-agent-ingestion.md for durability and retention contracts.
 */
import * as Sentry from '@sentry/cloudflare';
import { TRACE_FLOW_PROPAGATION_TARGETS } from '@trace-flow/utils/sentry-tracing';
import { sha256Hex } from '@trace-flow/utils';
import type { AgentConsumerEnv } from './context';
import type { ResumeSnapshotInput } from './snapshot-recovery';
import { discoverSnapshotCopy } from './snapshot-tinybird';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { AGENT_DEAD_LETTERS_INSTANCE_NAME } from './dead-letters';
import type {
  ReconcileRecoveryInput,
  RecoveryPage,
  RecoveryPageOptions,
  RecoveryRecord,
} from '@trace-flow/tinybird-client';
import type { AgentDeliveryStagedReference, AgentIngestQueueMessage } from '@trace-flow/types';
import { validateAgentIngestQueueMessage } from '@trace-flow/types';
import { validateAgentDeliveryKey, validateAgentDeliveryStagedReference } from '@trace-flow/utils';
import {
  hasDeliveryReferenceType,
  processDeliveryReferences,
  retryOffContractMessages,
} from './delivery-queue';
import { AGENT_SNAPSHOT_QUEUE_NAMES, processSnapshotQueue } from './snapshot-queue';
import { eraseAgentOrganization, organizationErasureStarted } from './organization-erasure';
import { MAX_ACTIVE_AGENT_DELIVERIES } from './agent-delivery-coordinator-contract';

export { AgentDeadLetters } from './dead-letters';
export { AgentDelivery } from './agent-delivery';
export { AgentDeliveryCoordinator } from './agent-delivery-coordinator';
export { SnapshotCapacity } from './snapshot-capacity';

const AGENT_DLQ_NAMES = new Set(['agent-ingest-dlq-dev', 'agent-ingest-dlq-prod']);
const DLQ_PRESERVATION_RETRY_DELAY_SECONDS = 60;
const DLQ_PRESERVATION_MAX_RETRY_DELAY_SECONDS = 14_400;

function normalizeAgentShardId(shardId: string): string {
  const normalized = shardId.trim();
  if (!normalized || normalized.length > 256 || normalized.includes(':')) {
    throw new Error('agent shardId must be a non-empty org ID without a colon');
  }
  return normalized;
}

function requireDeadLetterShard(shardId: string): void {
  if (shardId !== AGENT_DEAD_LETTERS_INSTANCE_NAME) {
    throw new Error(
      `Agent recovery records exist only in the shared dead-letter store; shardId must be "${AGENT_DEAD_LETTERS_INSTANCE_NAME}"`,
    );
  }
}

async function preserveDeadLetterBatch(
  batch: MessageBatch<unknown>,
  env: AgentConsumerEnv,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      const shardId = AGENT_DEAD_LETTERS_INSTANCE_NAME;
      const sink = env.AGENT_DEAD_LETTERS.getByName(shardId);
      const payload = JSON.stringify({
        queue: batch.queue,
        messageId: message.id,
        body: message.body,
      });
      const record = await sink.preserveDlq(
        payload,
        JSON.stringify({ reason: 'dead_letter_queue_delivery' }),
        message.id,
      );
      if (!validateAgentIngestQueueMessage(message.body)) {
        const orgId = (message.body as AgentIngestQueueMessage).tenancy.org_id;
        if (await organizationErasureStarted(env, orgId)) {
          await sink.discardDlq(record.id, await sha256Hex(payload));
        }
      }
      message.ack();
      Sentry.captureMessage('agent_consumer.dead_letter_preserved', {
        level: 'error',
        tags: { operation: 'dlq_preserve' },
        extra: { shardId, messageId: message.id },
      });
    } catch (error) {
      message.retry({
        delaySeconds: Math.min(
          DLQ_PRESERVATION_RETRY_DELAY_SECONDS * 2 ** (message.attempts - 1),
          DLQ_PRESERVATION_MAX_RETRY_DELAY_SECONDS,
        ),
      });
      Sentry.captureException(error, {
        level: 'fatal',
        tags: { operation: 'dlq_preserve' },
        extra: { queue: batch.queue, messageId: message.id, attempts: message.attempts },
      });
    }
  }
}

async function excludeErasedDeadLetters(
  messages: Message<unknown>[],
  env: AgentConsumerEnv,
): Promise<Message<unknown>[]> {
  const retained: Message<unknown>[] = [];
  for (const message of messages) {
    try {
      if (validateAgentIngestQueueMessage(message.body)) {
        retained.push(message);
        continue;
      }
      const orgId = (message.body as AgentIngestQueueMessage).tenancy.org_id;
      if (await organizationErasureStarted(env, orgId)) message.ack();
      else retained.push(message);
    } catch (error) {
      message.retry({ delaySeconds: DLQ_PRESERVATION_RETRY_DELAY_SECONDS });
      Sentry.captureException(error, {
        tags: { operation: 'dlq_erasure_check' },
        extra: { messageId: message.id },
      });
    }
  }
  return retained;
}

const handler = {
  // Queue bodies are untrusted; off-contract messages must retry until they reach the DLQ.
  async queue(batch: MessageBatch<unknown>, env: AgentConsumerEnv): Promise<void> {
    if (AGENT_SNAPSHOT_QUEUE_NAMES.has(batch.queue)) {
      await processSnapshotQueue(batch, env);
      return;
    }
    const references = batch.messages.filter((message) => hasDeliveryReferenceType(message.body));
    await processDeliveryReferences(references, env);
    const inline = batch.messages.filter((message) => !hasDeliveryReferenceType(message.body));
    if (inline.length === 0) return;
    if (AGENT_DLQ_NAMES.has(batch.queue)) {
      const retained = await excludeErasedDeadLetters(inline, env);
      if (retained.length > 0) await preserveDeadLetterBatch({ ...batch, messages: retained }, env);
      return;
    }
    await retryOffContractMessages(inline, batch.queue, env);
  },
};

class AgentIngestionEntrypoint extends WorkerEntrypoint<AgentConsumerEnv> {
  eraseOrganization(
    orgId: string,
    afterId?: number,
  ): Promise<{ ready: boolean; nextAfterId?: number }> {
    return eraseAgentOrganization(this.env, normalizeAgentShardId(orgId), afterId);
  }

  async canAcceptDeliveries(orgId: string): Promise<boolean> {
    const normalized = normalizeAgentShardId(orgId);
    const coordinator = this.env.AGENT_DELIVERY_COORDINATOR.getByName(`org:${normalized}`);
    const stats = await coordinator.getStats({});
    return (
      !stats.erasureStarted &&
      stats.gatePhase === 'open' &&
      stats.activeDeliveries < MAX_ACTIVE_AGENT_DELIVERIES
    );
  }

  async registerDelivery(
    reference: AgentDeliveryStagedReference,
    days: string[],
  ): Promise<number | null> {
    if (validateAgentDeliveryStagedReference(reference))
      throw new Error('Invalid delivery registration');
    return this.env.AGENT_DELIVERY.getByName(reference.key).register(reference, days);
  }

  async getDeliveryReceipt(
    key: string,
    orgId: string,
  ): Promise<AgentDeliveryStagedReference | null> {
    const normalized = normalizeAgentShardId(orgId);
    if (validateAgentDeliveryKey(key, normalized)) throw new Error('Invalid delivery receipt key');
    return this.env.AGENT_DELIVERY.getByName(key).receiptReference(normalized);
  }
}

class TraceRecoveryEntrypoint extends WorkerEntrypoint<AgentConsumerEnv> {
  async inspectDeliveryStatus(orgId: string, input: { discoverCopies?: boolean } = {}) {
    if (
      typeof input !== 'object' ||
      input === null ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => key !== 'discoverCopies') ||
      (input.discoverCopies !== undefined && typeof input.discoverCopies !== 'boolean')
    )
      throw new Error('Invalid snapshot inspection options');
    const normalized = normalizeAgentShardId(orgId);
    const coordinator = this.env.AGENT_DELIVERY_COORDINATOR.getByName(`org:${normalized}`);
    const intents = await coordinator.getOutstandingSnapshotCopyIntents({});
    return {
      ...(await coordinator.getStats({})),
      snapshotSchedule: await coordinator.getSnapshotSchedule({}),
      snapshotCopyIntents: intents,
      ...(input.discoverCopies
        ? {
            snapshotCopyDiscovery: await Promise.all(
              intents.map(async (intent) => ({
                intent,
                job: await discoverSnapshotCopy(this.env, normalized, intent),
              })),
            ),
          }
        : {}),
    };
  }

  async resumeSnapshot(orgId: string, input: Omit<ResumeSnapshotInput, 'orgId'>) {
    const normalized = normalizeAgentShardId(orgId);
    const coordinator = this.env.AGENT_DELIVERY_COORDINATOR.getByName(`org:${normalized}`);
    if (input.abandonUnstartedCopy !== undefined) {
      const expected = input.abandonUnstartedCopy;
      const intents = await coordinator.getOutstandingSnapshotCopyIntents({});
      const intent = intents[0];
      if (
        intents.length !== 1 ||
        intent?.generation !== input.generation ||
        intent.target !== expected.target ||
        intent.copyAttempt !== expected.copyAttempt ||
        intent.startedAt !== expected.startedAt ||
        intent.jobId !== undefined
      )
        throw new Error('Snapshot does not match the unstarted Copy');
      if (await discoverSnapshotCopy(this.env, normalized, intent))
        throw new Error('Snapshot Copy has a provider job; resume receipt discovery instead');
    }
    return coordinator.resumeSnapshot({
      ...input,
      orgId: normalized,
    });
  }

  listRecovery(shardId: string, options: RecoveryPageOptions = {}): Promise<RecoveryPage> {
    requireDeadLetterShard(shardId);
    return this.env.AGENT_DEAD_LETTERS.getByName(AGENT_DEAD_LETTERS_INSTANCE_NAME).listRecovery(
      options,
    );
  }

  reconcileRecovery(shardId: string, input: ReconcileRecoveryInput): Promise<RecoveryRecord> {
    requireDeadLetterShard(shardId);
    return this.env.AGENT_DEAD_LETTERS.getByName(
      AGENT_DEAD_LETTERS_INSTANCE_NAME,
    ).reconcileRecovery(input);
  }
}

function sentryOptions(env: AgentConsumerEnv) {
  return {
    dsn: env.SENTRY_DSN,
    release: env.CF_VERSION_METADATA?.id,
    environment: env.SENTRY_ENVIRONMENT ?? 'development',
    tracesSampleRate: 1.0,
    tracePropagationTargets: TRACE_FLOW_PROPAGATION_TARGETS,
    ...sentryRequestPrivacy(),
    enableRpcTracePropagation: true,
    rpcTracePropagationBindings: [
      'AGENT_DEAD_LETTERS',
      'AGENT_DELIVERY',
      'AGENT_DELIVERY_COORDINATOR',
      'AGENT_SNAPSHOT_CAPACITY',
    ],
  };
}

export const AgentIngestion = Sentry.withSentry(sentryOptions, AgentIngestionEntrypoint);
export const TraceRecovery = Sentry.withSentry(sentryOptions, TraceRecoveryEntrypoint);
export default Sentry.withSentry(sentryOptions, handler);
