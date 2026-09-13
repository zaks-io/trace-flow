import type { Context } from 'hono';
import { axiomConfigFromEnv, createWorkerLogger } from '@trace-flow/logging';
import { currentSentryTraceContext } from '@trace-flow/utils/sentry-tracing';
import {
  MAX_AGENT_ANALYTICS_DAY_BUCKETS,
  BodySizeLimitError,
  readBodyWithLimit,
  stageAgentDelivery,
  utf8ByteLength,
} from '@trace-flow/utils';
import type {
  AgentDeliveryReference,
  AgentIngestEnvelope,
  AgentIngestQueueFacts,
  AgentIngestQueueMessage,
  AgentIngestQueuePayload,
} from '@trace-flow/types';
import type { AgentIngestEnv } from './context';
import { authenticateCollector } from './auth';
import { checkCompatibility, getCompatibilityPolicy } from './policy';
import { assembleQueueFacts } from './ids';
import { ConvexUnreachableError, claimSessions } from './ownership';
import {
  assertQueueMessagesValid,
  chunkFacts,
  QueueFactTooLargeError,
  QueueMessageContractError,
} from './chunker';
import {
  MAX_COMMAND_EXCERPT,
  MAX_ERROR_EXCERPT,
  MAX_NAVIGATION_HINT_EXCERPT,
  MAX_TOOL_EXCERPT_TOTAL,
  capExcerpt,
  redactField,
} from './redaction';
import { validateEnvelopeShape } from './validation';
import { FutureAgentFactTimestampError, retainAgentAnalyticsFacts } from './fact-retention';
import {
  AgentFactIdentityConflictError,
  normalizeAgentFactIdentities,
} from './fact-identity-conflicts';

/** Collector authenticates with this header; the value is the raw Collector Credential secret. */
const COLLECTOR_SECRET_HEADER = 'X-Trace-Flow-Collector-Secret';

/** Hard cap on the request body. */
const MAX_INGEST_BYTES = 10 * 1024 * 1024;

// Cloudflare Queues `sendBatch` limits: ≤100 messages AND ≤256 KB total per call (each message also
// ≤128 KB, already enforced upstream by MAX_QUEUE_MESSAGE_BYTES). Grouping by message COUNT alone blew
// the 256 KB total — a few ~124 KB chunked messages exceed it — so we group by cumulative bytes with
// headroom for the batch's own JSON framing.
const QUEUE_SEND_BATCH_MAX_MESSAGES = 100;
const QUEUE_SEND_BATCH_MAX_BYTES = 240 * 1024;
const DELIVERY_GROUP_SIZE = 10;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Group `messages` into `sendBatch`-sized batches that respect BOTH the 100-message and 256 KB-total
 * caps. A single message already fits the per-message limit, so a message larger than the byte budget
 * still ships alone in its own batch rather than being dropped.
 */
function groupForSendBatch(messages: AgentIngestQueuePayload[]): AgentIngestQueuePayload[][] {
  const groups: AgentIngestQueuePayload[][] = [];
  let current: AgentIngestQueuePayload[] = [];
  let currentBytes = 0;

  for (const message of messages) {
    const size = encoder.encode(JSON.stringify(message)).length;
    const wouldOverflow =
      current.length > 0 &&
      (current.length >= QUEUE_SEND_BATCH_MAX_MESSAGES ||
        currentBytes + size > QUEUE_SEND_BATCH_MAX_BYTES);
    if (wouldOverflow) {
      groups.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(message);
    currentBytes += size;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/**
 * Ingest entrypoint for `POST /v1/ingest`. Gate order is deliberate: cheap rejections first, then
 * the control-plane round trips, then the re-redact + assemble + enqueue work. Every failure logs
 * before returning, and the logger is flushed in `finally` so nothing is lost on an early return.
 */
export async function handleIngest(c: Context<{ Bindings: AgentIngestEnv }>): Promise<Response> {
  const logger = createWorkerLogger({
    service: 'agent-ingest',
    request: c.req.raw,
    axiom: axiomConfigFromEnv(c.env),
    context: { component: 'ingest' },
  });

  try {
    const auth = await authenticateCollector(c.env, c.req.header(COLLECTOR_SECRET_HEADER), logger);
    if (!auth.ok) return c.json({ error: 'unauthorized', reason: auth.reason }, 401);
    const { credential } = auth;

    const { success } = await c.env.AGENT_INGEST_LIMITER.limit({ key: credential.orgId });
    if (!success) {
      logger.warn('agent_ingest.rate_limited', { org_id: credential.orgId });
      return c.json({ error: 'rate_limited' }, 429);
    }

    // Cheap pre-check: reject on the declared Content-Length before buffering the body.
    const declaredLength = Number(c.req.header('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_INGEST_BYTES) {
      logger.warn('agent_ingest.payload_too_large', { bytes: declaredLength, source: 'header' });
      return c.json({ error: 'payload_too_large' }, 413);
    }

    let buf: ArrayBuffer;
    try {
      buf = await readBodyWithLimit(c.req.raw.body, MAX_INGEST_BYTES);
    } catch (err) {
      if (err instanceof BodySizeLimitError) {
        logger.warn('agent_ingest.payload_too_large', { bytes: err.receivedBytes });
        return c.json({ error: 'payload_too_large' }, 413);
      }
      throw err;
    }

    // The Collector gzips the envelope and sends `Content-Encoding: gzip`; Workers does not
    // auto-decompress request bodies, so inflate it here. The byte ceiling applies to the *inflated*
    // size too, so a small compressed payload can't expand past the cap (gzip-bomb guard).
    let bodyText: string;
    if (isGzipEncoded(c.req.header('content-encoding'))) {
      const inflated = await inflateCapped(buf, MAX_INGEST_BYTES);
      if (!inflated.ok && inflated.reason === 'too_large') {
        logger.warn('agent_ingest.payload_too_large', {
          bytes: inflated.inflatedBytes,
          encoding: 'gzip',
        });
        return c.json({ error: 'payload_too_large' }, 413);
      }
      if (!inflated.ok) {
        logger.warn('agent_ingest.invalid_gzip', { bytes: buf.byteLength });
        return c.json({ error: 'invalid_envelope' }, 400);
      }
      bodyText = decoder.decode(inflated.bytes);
    } else {
      bodyText = decoder.decode(buf);
    }

    let parsedEnvelope: unknown;
    try {
      parsedEnvelope = JSON.parse(bodyText) as unknown;
    } catch {
      logger.warn('agent_ingest.invalid_json');
      return c.json({ error: 'invalid_envelope' }, 400);
    }
    const shapeError = validateEnvelopeShape(parsedEnvelope);
    if (shapeError) {
      logger.warn('agent_ingest.invalid_envelope');
      return c.json({ error: 'invalid_envelope' }, 400);
    }
    const envelope = parsedEnvelope as AgentIngestEnvelope;
    const { batch, facts } = envelope;

    const policy = await getCompatibilityPolicy(c.env, logger);
    if (!policy.ok) return c.json({ error: 'policy_unavailable' }, 503);
    const compat = checkCompatibility(policy.policy, batch.desktop_version, batch.parser_version);
    if (!compat.ok) {
      logger.warn('agent_ingest.upgrade_required', { detail: compat.detail });
      return c.json(
        {
          error: 'upgrade_required',
          detail: compat.detail,
          min_desktop_version: policy.policy.minDesktopVersion,
          min_parser_version: policy.policy.minParserVersion,
        },
        426,
      );
    }

    let retained;
    try {
      retained = retainAgentAnalyticsFacts(facts, Date.now());
    } catch (err) {
      if (err instanceof FutureAgentFactTimestampError) {
        logger.warn('agent_ingest.future_fact_timestamp', { category: err.category });
        return c.json({ error: 'invalid_envelope' }, 400);
      }
      throw err;
    }
    const retainedFacts = retained.facts;
    const excludedByRetention = retained.excludedByRetention;
    if (isEmpty(retainedFacts)) {
      return c.json(
        { accepted: true, sessions: 0, excluded_by_retention: excludedByRetention },
        202,
      );
    }

    reRedact(retainedFacts);

    const assembled = await assembleQueueFacts(retainedFacts, batch.source);
    let queueFacts: AgentIngestQueueFacts;
    try {
      queueFacts = normalizeAgentFactIdentities(assembled.queueFacts);
    } catch (err) {
      if (err instanceof AgentFactIdentityConflictError) {
        logger.warn('agent_ingest.fact_identity_conflict', { category: err.category });
        return c.json({ error: 'invalid_envelope' }, 400);
      }
      throw err;
    }
    const { sessionPks } = assembled;

    const base: Omit<AgentIngestQueueMessage, 'facts'> = {
      type: 'agent',
      source: batch.source,
      parser_version: batch.parser_version,
      desktop_version: batch.desktop_version,
      collector_batch_id: batch.collector_batch_id,
      tenancy: {
        org_id: credential.orgId,
        user_id: credential.userId,
        collector_id: credential.collectorId,
        collector_credential_id: credential.collectorCredentialId,
      },
      enqueued_at: Date.now(),
      // Carried on every chunk so the consumer's work joins this ingest request's trace. `chunkFacts`
      // sizes each message from `base`, so the extra bytes stay inside the per-message byte budget.
      sentry_trace_context: currentSentryTraceContext(),
    };

    // Validate the exact transport chunks before claiming ownership so an impossible write cannot
    // create a claim. Derived attribution rows may push the assembled total above the input envelope
    // limit, so validating the unchunked aggregate would reject valid batches.
    let candidateMessages: AgentIngestQueueMessage[];
    try {
      candidateMessages = chunkFacts(base, queueFacts);
      assertQueueMessagesValid(candidateMessages);
    } catch (err) {
      if (err instanceof QueueFactTooLargeError) {
        logger.warn('agent_ingest.fact_too_large', {
          category: err.category,
          bytes: err.factBytes,
          max_bytes: err.maxBytes,
        });
        return c.json({ error: 'payload_too_large' }, 413);
      }
      if (err instanceof QueueMessageContractError) {
        logger.error('agent_ingest.queue_contract_invalid', undefined, {
          field: err.field,
        });
        return c.json({ error: 'internal_error' }, 500);
      }
      throw err;
    }

    let claims;
    try {
      claims = await claimSessions(
        c.env,
        {
          orgId: credential.orgId,
          userId: credential.userId,
          collectorId: credential.collectorId,
          hashedSecret: credential.collectorCredentialId,
          sessionPks,
        },
        logger,
      );
    } catch (err) {
      if (err instanceof ConvexUnreachableError) {
        return c.json({ error: 'session_claim_unavailable' }, 503);
      }
      logger.error('agent_ingest.claim_unexpected_error', err);
      return c.json({ error: 'internal_error' }, 500);
    }

    const conflicted = new Set(
      claims.filter((cl) => cl.status === 'conflict').map((cl) => cl.sessionPk),
    );
    const owned = dropConflicted(queueFacts, conflicted);
    const ownedSessions = sessionPks.length - conflicted.size;
    if (isEmpty(owned)) {
      logger.info('agent_ingest.all_sessions_conflict', { sessions: sessionPks.length });
      return c.json(
        {
          accepted: true,
          sessions: 0,
          skipped_conflict: conflicted.size,
          excluded_by_retention: excludedByRetention,
        },
        202,
      );
    }

    const enqueuedAt = Date.now();
    const messages =
      conflicted.size === 0
        ? candidateMessages.map((message) => ({ ...message, enqueued_at: enqueuedAt }))
        : chunkFacts({ ...base, enqueued_at: enqueuedAt }, owned);

    try {
      await publishDeliveryGroups(c.env, messages, enqueuedAt);
    } catch (err) {
      logger.error('agent_ingest.delivery_publish_failed', err, { messages: messages.length });
      return c.json({ error: 'enqueue_failed' }, 503);
    }

    logger.info('agent_ingest.accepted', {
      sessions: ownedSessions,
      messages: messages.length,
      skipped_conflict: conflicted.size,
      excluded_by_retention: excludedByRetention,
    });
    return c.json(
      {
        accepted: true,
        sessions: ownedSessions,
        skipped_conflict: conflicted.size,
        excluded_by_retention: excludedByRetention,
      },
      202,
    );
  } finally {
    await logger.flush();
  }
}

async function publishDeliveryGroups(
  env: AgentIngestEnv,
  messages: AgentIngestQueueMessage[],
  now: number,
): Promise<void> {
  for (let offset = 0; offset < messages.length; offset += DELIVERY_GROUP_SIZE) {
    const messageGroup = messages.slice(offset, offset + DELIVERY_GROUP_SIZE);
    const orgId = messageGroup[0]!.tenancy.org_id;
    if (!(await env.AGENT_CONSUMER.canAcceptDeliveries(orgId))) {
      throw new Error('Agent delivery admission is temporarily unavailable');
    }
    const days = messageGroup.map(deliveryDays);
    const staged = await settleAll(
      messageGroup.map((message) =>
        stageAgentDelivery({
          storage: env.AGENT_DELIVERIES,
          message,
          encryption: {
            rootKeyBase64: env.BODY_ENCRYPTION_ROOT_KEY,
            keyId: env.BODY_ENCRYPTION_KEY_ID,
          },
          now,
        }),
      ),
    );
    const deliveries = await settleAll(
      staged.map(async (reference, index): Promise<AgentDeliveryReference> => {
        const revision = await env.AGENT_CONSUMER.registerDelivery(reference, days[index]!);
        if (!Number.isSafeInteger(revision) || revision <= 0) {
          throw new Error('Agent consumer returned an invalid delivery revision');
        }
        return { ...reference, delivery_revision: revision };
      }),
    );

    // Every delivery in this group is durable and registered before the first Queue write. A failed
    // send keeps the encrypted objects and registrations available for the recovery sweep.
    for (const group of groupForSendBatch(deliveries)) {
      await env.AGENT_QUEUE.sendBatch(group.map((body) => ({ body })));
    }
  }
}

async function settleAll<T>(promises: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(promises);
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failure) throw failure.reason;
  return results.map((result) => {
    if (result.status !== 'fulfilled') throw new Error('Unreachable rejected delivery operation');
    return result.value;
  });
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
  const days = [
    ...new Set(timestamps.map((timestamp) => new Date(timestamp).toISOString().slice(0, 10))),
  ].sort();
  if (days.length === 0 || days.length > MAX_AGENT_ANALYTICS_DAY_BUCKETS) {
    throw new Error('Agent delivery has an invalid retention-day set');
  }
  return days;
}

/** True when the request declares a gzip body (case-insensitive; the Collector sends exactly `gzip`). */
function isGzipEncoded(contentEncoding: string | undefined): boolean {
  return contentEncoding?.trim().toLowerCase() === 'gzip';
}

type InflateResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: 'too_large'; inflatedBytes: number }
  | { ok: false; reason: 'invalid' };

/**
 * Inflate a gzip body, enforcing `maxBytes` on the *inflated* output so a small compressed payload
 * can't exceed the cap. `too_large` carries the inflated byte count seen at the breach (so the
 * log distinguishes a gzip bomb from an exact-limit hit) and maps to a 413; `invalid` (a malformed
 * stream) maps to a 400.
 */
async function inflateCapped(buf: ArrayBuffer, maxBytes: number): Promise<InflateResult> {
  try {
    const stream = new Response(buf).body!.pipeThrough(new DecompressionStream('gzip'));
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        // The stream is already being abandoned; a cancel that throws must not downgrade this to a 400.
        try {
          await reader.cancel();
        } catch {
          /* already closing */
        }
        return { ok: false, reason: 'too_large', inflatedBytes: total };
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, bytes: out };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}

function isEmpty(facts: AgentIngestQueueFacts | AgentIngestEnvelope['facts']): boolean {
  const reviewUnitAttributions = (facts as Partial<AgentIngestQueueFacts>).review_unit_attributions;
  return (
    facts.messages.length === 0 &&
    facts.tool_events.length === 0 &&
    facts.file_events.length === 0 &&
    facts.capability_snapshots.length === 0 &&
    facts.pull_request_links.length === 0 &&
    (reviewUnitAttributions?.length ?? 0) === 0
  );
}

/** Re-runs the redaction backstop over the only free-text fields, capping excerpts to their column. */
function reRedact(facts: AgentIngestEnvelope['facts']): void {
  for (const t of facts.tool_events) {
    const cmd = redactField(t.command_excerpt);
    t.command_excerpt = capExcerpt(cmd.value, MAX_COMMAND_EXCERPT);
    const errExcerpt = redactField(t.error_excerpt);
    t.error_excerpt = capExcerpt(errExcerpt.value, MAX_ERROR_EXCERPT);
    let remaining = Math.max(
      0,
      MAX_TOOL_EXCERPT_TOTAL - utf8ByteLength(t.command_excerpt) - utf8ByteLength(t.error_excerpt),
    );
    const navigationPath = redactField(t.navigation_path_hint ?? '');
    t.navigation_path_hint = capExcerpt(
      navigationPath.value,
      Math.min(MAX_NAVIGATION_HINT_EXCERPT, remaining),
    );
    remaining = Math.max(0, remaining - utf8ByteLength(t.navigation_path_hint));
    const navigationPattern = redactField(t.navigation_pattern_hint ?? '');
    t.navigation_pattern_hint = capExcerpt(
      navigationPattern.value,
      Math.min(MAX_NAVIGATION_HINT_EXCERPT, remaining),
    );
    t.dropped_sensitive =
      (t.dropped_sensitive ?? 0) +
      cmd.dropped +
      errExcerpt.dropped +
      navigationPath.dropped +
      navigationPattern.dropped;
  }
  for (const f of facts.file_events) {
    const path = redactField(f.normalized_repo_path);
    f.normalized_repo_path = path.value;
    f.dropped_sensitive = (f.dropped_sensitive ?? 0) + path.dropped;
  }
}

/** Removes every fact belonging to a conflicted (lost-ownership) session. */
function dropConflicted(
  facts: AgentIngestQueueFacts,
  conflicted: Set<string>,
): AgentIngestQueueFacts {
  if (conflicted.size === 0) return facts;
  const keep = <T extends { session_pk: string }>(rows: T[]): T[] =>
    rows.filter((r) => !conflicted.has(r.session_pk));
  return {
    messages: keep(facts.messages),
    tool_events: keep(facts.tool_events),
    file_events: keep(facts.file_events),
    capability_snapshots: keep(facts.capability_snapshots),
    pull_request_links: keep(facts.pull_request_links),
    review_unit_attributions: keep(facts.review_unit_attributions ?? []),
  };
}
