import * as Sentry from '@sentry/cloudflare';
import { isAgentIngestQueueMessage, type AgentIngestQueueMessage } from '@trace-flow/types';
import { axiomConfigFromEnv, createLogger } from '@trace-flow/logging';
import { continueQueueTrace, groupBySentryTrace } from '@trace-flow/utils/sentry-tracing';
import type { AgentConsumerEnv } from './context';
import {
  CATEGORIES,
  ROW_IDENTITY_FIELDS,
  emptyAccumulator,
  rowIdentity,
  type Accumulator,
} from './facts';
import { PriceCache, priceMessage } from './pricing';
import { flushFacts, flushRowsByOrg } from './fact-flush';
import {
  batchContext,
  capabilitySnapshotRow,
  fileEventRow,
  messageRow,
  pullRequestLinkRow,
  reviewUnitAttributionRow,
  toolEventRow,
} from './rows';

/**
 * Full queue-contract guard and the named "malformed message → DLQ" trigger. The producer is our own
 * worker, so a failing guard means contract drift or a foreign message: dead-letter rather than drop.
 */
export function isQueueMessage(body: unknown): body is AgentIngestQueueMessage {
  return isAgentIngestQueueMessage(body);
}

export async function processAgentRecoveryPayload(
  body: unknown,
  env: AgentConsumerEnv,
): Promise<void> {
  if (!isQueueMessage(body)) throw new Error('DLQ payload still fails the agent queue contract');
  const logger = createLogger({
    service: 'agent-consumer',
    runtime: 'cloudflare-worker',
    axiom: axiomConfigFromEnv(env),
    context: { component: 'recovery-replay' },
  });
  try {
    const acc = emptyAccumulator();
    await accumulateMessage(body, acc, new PriceCache(env.MODEL_PRICING));
    dedupeAccumulator(acc);
    if (!(await flushFacts(acc, env, logger)))
      throw new Error('agent recovery replay was not durably staged');
  } finally {
    await logger.flush();
  }
}

/** Maps one well-formed message's facts into the row accumulator, pricing each Agent Message. */
async function accumulateMessage(
  body: AgentIngestQueueMessage,
  acc: Accumulator,
  cache: PriceCache,
): Promise<void> {
  const ctx = batchContext(body);

  for (const fact of body.facts.messages) {
    const cost = await priceMessage(fact, body.source, cache);
    acc.messages.push(messageRow(ctx, fact, cost));
  }
  for (const fact of body.facts.tool_events) {
    acc.tool_events.push(toolEventRow(ctx, fact));
  }
  for (const fact of body.facts.file_events) {
    acc.file_events.push(fileEventRow(ctx, fact));
  }
  for (const fact of body.facts.capability_snapshots) {
    acc.capability_snapshots.push(capabilitySnapshotRow(ctx, fact));
  }
  for (const fact of body.facts.pull_request_links) {
    acc.pull_request_links.push(pullRequestLinkRow(ctx, fact));
  }
  for (const fact of body.facts.review_unit_attributions ?? []) {
    acc.review_unit_attributions.push(reviewUnitAttributionRow(ctx, fact));
  }
}

function dedupeAccumulator(acc: Accumulator): number {
  let removed = 0;
  for (const category of CATEGORIES) {
    const before = acc[category].length;
    acc[category] = dedupeRows(acc[category], ROW_IDENTITY_FIELDS[category]);
    removed += before - acc[category].length;
  }
  return removed;
}

function mergeAccumulator(target: Accumulator, source: Accumulator): void {
  for (const category of CATEGORIES) target[category].push(...source[category]);
}

function dedupeRows(rows: unknown[], keyFields: string[]): unknown[] {
  const byKey = new Map<string, unknown>();
  for (const row of rows) {
    const key = rowIdentity(row, keyFields);
    const prior = byKey.get(key);
    if (!prior || compareIngestedAt(row, prior) >= 0) {
      byKey.set(key, row);
    }
  }
  return [...byKey.values()];
}

function compareIngestedAt(left: unknown, right: unknown): number {
  const l = isRecord(left) && typeof left.IngestedAt === 'string' ? left.IngestedAt : '';
  const r = isRecord(right) && typeof right.IngestedAt === 'string' ? right.IngestedAt : '';
  return l.localeCompare(r);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Drains one queue batch: prices each message and accumulates one row set per base datasource.
 * Named failure paths: a malformed message dead-letters after retry exhaustion, and a ledger failure
 * retries the messages for that organization. Duplicate redelivery is absorbed by the
 * AgentFactBatcher ledger before Tinybird insert.
 */
export async function processAgentBatch(
  batch: MessageBatch<unknown>,
  env: AgentConsumerEnv,
): Promise<void> {
  const logger = createLogger({
    service: 'agent-consumer',
    runtime: 'cloudflare-worker',
    axiom: axiomConfigFromEnv(env),
    context: { component: 'queue-consumer' },
  });

  const cache = new PriceCache(env.MODEL_PRICING);
  const wellFormed: Message<unknown>[] = [];
  const byOrg = new Map<string, { rows: Accumulator; messages: Message<unknown>[] }>();

  const accumulate = async (message: Message<unknown>): Promise<void> => {
    try {
      if (!isQueueMessage(message.body)) {
        logger.error('agent_consumer.message_malformed', undefined, { messageId: message.id });
        Sentry.captureMessage('agent_consumer.message_malformed', {
          level: 'error',
          tags: { operation: 'guard' },
          extra: { messageId: message.id },
        });
        message.retry();
        return;
      }
      const messageRows = emptyAccumulator();
      await accumulateMessage(message.body, messageRows, cache);
      const orgId = message.body.tenancy.org_id;
      let orgBatch = byOrg.get(orgId);
      if (!orgBatch) {
        orgBatch = { rows: emptyAccumulator(), messages: [] };
        byOrg.set(orgId, orgBatch);
      }
      mergeAccumulator(orgBatch.rows, messageRows);
      orgBatch.messages.push(message);
      wellFormed.push(message);
    } catch (error) {
      logger.error('agent_consumer.message_process_failed', error, { messageId: message.id });
      Sentry.captureException(error, {
        level: 'error',
        tags: { operation: 'accumulate' },
        extra: { messageId: message.id },
      });
      message.retry();
    }
  };

  try {
    // Agent Ingest chunks one HTTP request into up to a hundred queue messages, so group by the
    // producing trace: one `queue.process` transaction continuing that ingest request rather than one
    // per message. The Tinybird flush below spans the whole batch and stays under the batch's own
    // transaction.
    const groups = groupBySentryTrace(batch.messages, (message) =>
      isQueueMessage(message.body) ? message.body.sentry_trace_context : undefined,
    );
    for (const group of groups) {
      await continueQueueTrace(
        group.traceContext,
        { queueName: batch.queue, messageCount: group.messages.length },
        async () => {
          for (const message of group.messages) {
            await accumulate(message);
          }
        },
      );
    }

    if (wellFormed.length === 0) {
      logger.warn('agent_consumer.batch_all_malformed', { totalMessages: batch.messages.length });
      return;
    }

    let dedupedRows = 0;
    for (const { rows } of byOrg.values()) dedupedRows += dedupeAccumulator(rows);
    const failedOrgIds = await flushRowsByOrg(
      new Map([...byOrg].map(([orgId, value]) => [orgId, value.rows])),
      env,
      logger,
    );
    let retried = 0;
    for (const [orgId, orgBatch] of byOrg) {
      for (const message of orgBatch.messages) {
        if (failedOrgIds.has(orgId)) {
          message.retry();
          retried++;
        } else {
          message.ack();
        }
      }
    }
    if (retried > 0) {
      logger.warn('agent_consumer.batch_retried', {
        retried,
        failedOrganizations: failedOrgIds.size,
      });
      return;
    }

    logger.info('agent_consumer.batch_processed', {
      messages: wellFormed.length,
      rows: [...byOrg.values()].reduce(
        (sum, orgBatch) =>
          sum + CATEGORIES.reduce((orgSum, category) => orgSum + orgBatch.rows[category].length, 0),
        0,
      ),
      dedupedRows,
    });
  } finally {
    await logger.flush();
  }
}
