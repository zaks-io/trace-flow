import * as Sentry from '@sentry/cloudflare';
import type { AgentDeliveryReference, AgentIngestQueueMessage } from '@trace-flow/types';
import { validateAgentIngestQueueMessage } from '@trace-flow/types';
import { agentAnalyticsDayBounds, stageAgentDelivery } from '@trace-flow/utils';
import type { AgentConsumerEnv } from './context';

const CONCURRENT_LEGACY_DELIVERIES = 6;

export async function processMigratedLegacyMessage(
  message: Message<unknown>,
  env: AgentConsumerEnv,
): Promise<boolean> {
  if (validateAgentIngestQueueMessage(message.body)) return false;
  const body = message.body as AgentIngestQueueMessage;
  const orgId = body.tenancy.org_id;
  if (await agentIngestionErasureStarted(env, orgId)) {
    message.ack();
    return true;
  }
  const coordinator = env.AGENT_DELIVERY_COORDINATOR.getByName(`org:${orgId}`);
  const migration = await coordinator.getIngestionMigrationState();
  if (migration?.complete !== true) {
    const legacy = env.AGENT_FACT_BATCHER.getByName(`org:${orgId}`);
    const legacyMigration = await legacy.getIngestionMigrationState();
    if (legacyMigration.migrationId === null) return false;
    throw new Error('Ingestion baseline migration is incomplete');
  }

  const retained = retainLegacyMessage(body, Date.now());
  if (messageFactCount(retained) === 0) {
    message.ack();
    return true;
  }

  const days = deliveryDays(retained);
  const staged = await stageAgentDelivery({
    storage: env.AGENT_DELIVERIES,
    message: retained,
    encryption: { rootKeyBase64: env.BODY_ENCRYPTION_ROOT_KEY },
  });
  const delivery = env.AGENT_DELIVERY.getByName(staged.key);
  const revision = await delivery.register(staged, days, { legacySourceOrder: true });
  if (!Number.isSafeInteger(revision) || revision <= 0) {
    throw new Error('Agent delivery returned an invalid revision');
  }
  const reference: AgentDeliveryReference = { ...staged, delivery_revision: revision };
  await delivery.process(reference);
  message.ack();
  return true;
}

export async function agentIngestionErasureStarted(
  env: AgentConsumerEnv,
  orgId: string,
): Promise<boolean> {
  const coordinator = env.AGENT_DELIVERY_COORDINATOR.getByName(`org:${orgId}`);
  return (await coordinator.getErasureState({})) !== null;
}

export async function processMigratedLegacyMessages(
  messages: readonly Message<unknown>[],
  env: AgentConsumerEnv,
): Promise<Message<unknown>[]> {
  const unhandled = new Set<Message<unknown>>();
  for (let offset = 0; offset < messages.length; offset += CONCURRENT_LEGACY_DELIVERIES) {
    await Promise.all(
      messages.slice(offset, offset + CONCURRENT_LEGACY_DELIVERIES).map(async (message) => {
        try {
          if (!(await processMigratedLegacyMessage(message, env))) unhandled.add(message);
        } catch (error) {
          message.retry({ delaySeconds: 60 });
          Sentry.captureException(error, {
            tags: { operation: 'legacy_delivery_migration' },
            extra: { messageId: message.id },
          });
        }
      }),
    );
  }
  return messages.filter((message) => unhandled.has(message));
}

function retainLegacyMessage(
  message: AgentIngestQueueMessage,
  now: number,
): AgentIngestQueueMessage {
  const { oldestDayStart, tomorrowStart } = agentAnalyticsDayBounds(now);
  const retain = <T>(rows: T[], timestamp: (row: T) => number): T[] =>
    rows.filter((row) => {
      const eventAt = timestamp(row);
      if (eventAt >= tomorrowStart) throw new Error('Legacy delivery contains a future-day fact');
      return eventAt >= oldestDayStart;
    });

  return {
    ...message,
    facts: {
      messages: retain(message.facts.messages, (fact) => fact.event_at),
      tool_events: retain(message.facts.tool_events, (fact) => fact.event_at),
      file_events: retain(message.facts.file_events, (fact) => fact.event_at),
      capability_snapshots: retain(message.facts.capability_snapshots, (fact) => fact.event_at),
      pull_request_links: retain(message.facts.pull_request_links, (fact) => fact.event_at),
      review_unit_attributions: retain(
        message.facts.review_unit_attributions ?? [],
        (fact) => fact.decided_at,
      ),
    },
  };
}

function deliveryDays(message: AgentIngestQueueMessage): string[] {
  const timestamps = [
    ...message.facts.messages.map((fact) => fact.event_at),
    ...message.facts.tool_events.map((fact) => fact.event_at),
    ...message.facts.file_events.map((fact) => fact.event_at),
    ...message.facts.capability_snapshots.map((fact) => fact.event_at),
    ...message.facts.pull_request_links.map((fact) => fact.event_at),
    ...(message.facts.review_unit_attributions ?? []).map((fact) => fact.decided_at),
  ];
  return [
    ...new Set(timestamps.map((timestamp) => new Date(timestamp).toISOString().slice(0, 10))),
  ].sort();
}

function messageFactCount(message: AgentIngestQueueMessage): number {
  return (
    message.facts.messages.length +
    message.facts.tool_events.length +
    message.facts.file_events.length +
    message.facts.capability_snapshots.length +
    message.facts.pull_request_links.length +
    (message.facts.review_unit_attributions?.length ?? 0)
  );
}
