import * as Sentry from '@sentry/cloudflare';
import type { AgentIngestQueueMessage } from '@trace-flow/types';
import { axiomConfigFromEnv, createLogger } from '@trace-flow/logging';
import { insertRows } from '@trace-flow/tinybird-client';
import type { AgentConsumerEnv } from './context';
import { PriceCache, priceMessage } from './pricing';
import {
  batchContext,
  capabilitySnapshotRow,
  fileEventRow,
  messageRow,
  pullRequestLinkRow,
  toolEventRow,
} from './rows';

type Logger = ReturnType<typeof createLogger>;

/** Base fact category → its Tinybird datasource name. Order is the insert order. */
const DATASOURCES = {
  messages: 'agent_messages',
  tool_events: 'agent_tool_events',
  file_events: 'agent_file_events',
  capability_snapshots: 'agent_capability_snapshots',
  pull_request_links: 'agent_pull_request_links',
} as const;

type Category = keyof typeof DATASOURCES;

const CATEGORIES = Object.keys(DATASOURCES) as Category[];

type Accumulator = Record<Category, unknown[]>;

function emptyAccumulator(): Accumulator {
  return {
    messages: [],
    tool_events: [],
    file_events: [],
    capability_snapshots: [],
    pull_request_links: [],
  };
}

/**
 * Structural guard — the named "malformed message → DLQ" trigger. The producer is our own worker, so
 * a failing guard means contract drift or a foreign message: dead-letter rather than drop. It checks
 * the scalar fields `accumulateMessage` dereferences (source, parser_version, tenancy ids), not just
 * the container shape, so contract drift surfaces here instead of as an opaque mapping error.
 */
function isQueueMessage(body: unknown): body is AgentIngestQueueMessage {
  if (typeof body !== 'object' || body === null) {
    return false;
  }
  const m = body as Record<string, unknown>;
  if (m.type !== 'agent' || typeof m.enqueued_at !== 'number') {
    return false;
  }
  if (!isNonEmptyString(m.source) || !isNonEmptyString(m.parser_version)) {
    return false;
  }
  if (!isTenancy(m.tenancy)) {
    return false;
  }
  const facts = m.facts;
  if (typeof facts !== 'object' || facts === null) {
    return false;
  }
  const f = facts as Record<string, unknown>;
  return CATEGORIES.every((category) => Array.isArray(f[category]));
}

const TENANCY_FIELDS = ['org_id', 'user_id', 'collector_id', 'collector_credential_id'] as const;

function isTenancy(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const t = value as Record<string, unknown>;
  return TENANCY_FIELDS.every((field) => isNonEmptyString(t[field]));
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0;
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
}

/** Inserts every non-empty category. Returns the categories whose insert failed (empty = all ok). */
async function flush(acc: Accumulator, env: AgentConsumerEnv, logger: Logger): Promise<Category[]> {
  const pending = CATEGORIES.filter((category) => acc[category].length > 0);

  const results = await Promise.allSettled(
    pending.map((category) =>
      insertRows(acc[category], env.TINYBIRD_TOKEN, DATASOURCES[category], env.TINYBIRD_HOST),
    ),
  );

  return pending.filter((category, index) => {
    const result = results[index]!;
    if (result.status === 'rejected') {
      logger.error('agent_consumer.insert_failed', result.reason, {
        datasource: DATASOURCES[category],
        rows: acc[category].length,
      });
      Sentry.captureException(result.reason, {
        level: 'error',
        tags: { operation: 'insert', datasource: DATASOURCES[category] },
        extra: { rows: acc[category].length },
      });
      return true;
    }
    return false;
  });
}

/**
 * Drains one queue batch: prices each message, accumulates one row set per base datasource, and
 * issues one insert per datasource. Named failure paths — a malformed message dead-letters (retry
 * exhausts to the DLQ); an insert failure retries every contributing message (re-POST is safe under
 * `ReplacingMergeTree(IngestedAt)` FINAL). Nothing is silently dropped.
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
  const acc = emptyAccumulator();
  const wellFormed: Message<unknown>[] = [];

  try {
    for (const message of batch.messages) {
      try {
        if (!isQueueMessage(message.body)) {
          logger.error('agent_consumer.message_malformed', undefined, { messageId: message.id });
          Sentry.captureMessage('agent_consumer.message_malformed', {
            level: 'error',
            tags: { operation: 'guard' },
            extra: { messageId: message.id },
          });
          message.retry();
          continue;
        }
        await accumulateMessage(message.body, acc, cache);
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
    }

    if (wellFormed.length === 0) {
      logger.warn('agent_consumer.batch_all_malformed', { totalMessages: batch.messages.length });
      return;
    }

    const failed = await flush(acc, env, logger);
    if (failed.length > 0) {
      for (const message of wellFormed) {
        message.retry();
      }
      logger.warn('agent_consumer.batch_retried', {
        failedDatasources: failed.map((c) => DATASOURCES[c]),
        retried: wellFormed.length,
      });
      return;
    }

    for (const message of wellFormed) {
      message.ack();
    }
    logger.info('agent_consumer.batch_processed', {
      messages: wellFormed.length,
      rows: CATEGORIES.reduce((sum, category) => sum + acc[category].length, 0),
    });
  } finally {
    await logger.flush();
  }
}
