import * as Sentry from '@sentry/cloudflare';
import type { AgentIngestQueueMessage } from '@trace-flow/types';
import { axiomConfigFromEnv, createLogger } from '@trace-flow/logging';
import { insertRows } from '@trace-flow/tinybird-client';
import { continueQueueTrace, groupBySentryTrace } from '@trace-flow/utils/sentry-tracing';
import type { AgentConsumerEnv } from './context';
import {
  CATEGORIES,
  LEGACY_CATEGORIES,
  LEGACY_DATASOURCES,
  ROW_IDENTITY_FIELDS,
  emptyAccumulator,
  rowIdentity,
  rowOrgId,
  type Accumulator,
} from './facts';
import { PriceCache, priceMessage } from './pricing';
import {
  batchContext,
  capabilitySnapshotRow,
  fileEventRow,
  messageRow,
  pullRequestLinkRow,
  reviewUnitAttributionRow,
  toolEventRow,
} from './rows';

type Logger = ReturnType<typeof createLogger>;
type WriteMode = 'clean' | 'legacy' | 'dual';

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
  return CATEGORIES.every((category) => {
    if (category === 'review_unit_attributions') {
      return f[category] === undefined || Array.isArray(f[category]);
    }
    return Array.isArray(f[category]);
  });
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
  for (const fact of body.facts.review_unit_attributions ?? []) {
    acc.review_unit_attributions.push(reviewUnitAttributionRow(ctx, fact));
  }
}

/** Hands rows to the configured Tinybird write targets. Returns false when any target failed. */
async function flush(acc: Accumulator, env: AgentConsumerEnv, logger: Logger): Promise<boolean> {
  const mode = writeMode(env);
  if (mode === 'legacy') {
    return flushLegacy(acc, env, logger);
  }
  return flushClean(acc, env, logger, mode === 'dual');
}

function writeMode(env: AgentConsumerEnv): WriteMode {
  const mode = env.TINYBIRD_AGENT_WRITE_MODE ?? 'clean';
  if (mode === 'clean' || mode === 'legacy' || mode === 'dual') {
    return mode;
  }
  throw new Error(`invalid TINYBIRD_AGENT_WRITE_MODE: ${mode}`);
}

/** Hands rows to the sharded Durable Object ledger. Returns false when any shard failed. */
async function flushClean(
  acc: Accumulator,
  env: AgentConsumerEnv,
  logger: Logger,
  writeLegacy: boolean,
): Promise<boolean> {
  const byOrg = groupRowsByOrg(acc);
  if (byOrg.size === 0) {
    return true;
  }

  const results = await Promise.allSettled(
    [...byOrg.entries()].map(async ([orgId, rows]) => {
      const batcher = env.AGENT_FACT_BATCHER.getByName(`org:${orgId}`);
      const result = await batcher.addFacts({ rows, writeLegacy });
      if (result.status === 'failed') {
        throw new Error(`agent fact batcher rejected org ${orgId}`);
      }
      if (result.repairRows > 0) {
        logger.warn('agent_consumer.repair_rows_detected', {
          orgId,
          repairRows: result.repairRows,
        });
      }
    }),
  );

  let ok = true;
  for (const result of results) {
    if (result.status === 'rejected') {
      ok = false;
      logger.error('agent_consumer.fact_batcher_failed', result.reason);
      Sentry.captureException(result.reason, { tags: { operation: 'agent_fact_batcher' } });
    }
  }
  return ok;
}

/** Writes legacy ReplacingMergeTree tables during the rollout rollback window. */
async function flushLegacy(
  acc: Accumulator,
  env: AgentConsumerEnv,
  logger: Logger,
): Promise<boolean> {
  const results = await Promise.allSettled(
    LEGACY_CATEGORIES.filter((category) => acc[category].length > 0).map((category) =>
      insertRows(
        acc[category],
        env.TINYBIRD_TOKEN,
        LEGACY_DATASOURCES[category],
        env.TINYBIRD_HOST,
      ),
    ),
  );

  let ok = true;
  for (const result of results) {
    if (result.status === 'rejected') {
      ok = false;
      logger.error('agent_consumer.legacy_insert_failed', result.reason);
      Sentry.captureException(result.reason, { tags: { operation: 'agent_legacy_insert' } });
    }
  }
  return ok;
}

function groupRowsByOrg(acc: Accumulator): Map<string, Accumulator> {
  const byOrg = new Map<string, Accumulator>();
  for (const category of CATEGORIES) {
    for (const row of acc[category]) {
      const orgId = rowOrgId(row);
      if (!orgId) {
        continue;
      }
      let orgRows = byOrg.get(orgId);
      if (!orgRows) {
        orgRows = emptyAccumulator();
        byOrg.set(orgId, orgRows);
      }
      orgRows[category].push(row);
    }
  }
  return byOrg;
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
 * Named failure paths — a malformed message dead-letters (retry
 * exhausts to the DLQ); a ledger failure retries every contributing message. Duplicate redelivery is
 * absorbed by the AgentFactBatcher ledger before Tinybird insert. Nothing is silently dropped.
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

    const dedupedRows = dedupeAccumulator(acc);
    const flushed = await flush(acc, env, logger);
    if (!flushed) {
      for (const message of wellFormed) {
        message.retry();
      }
      logger.warn('agent_consumer.batch_retried', {
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
      dedupedRows,
    });
  } finally {
    await logger.flush();
  }
}
