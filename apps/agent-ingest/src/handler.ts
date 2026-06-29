import type { Context } from 'hono';
import { axiomConfigFromEnv, createWorkerLogger } from '@trace-flow/logging';
import type {
  AgentIngestEnvelope,
  AgentIngestQueueFacts,
  AgentIngestQueueMessage,
} from '@trace-flow/types';
import type { AgentIngestEnv } from './context';
import { authenticateCollector } from './auth';
import { checkCompatibility, getCompatibilityPolicy } from './policy';
import { assembleQueueFacts } from './ids';
import { ConvexUnreachableError, claimSessions } from './ownership';
import { chunkFacts } from './chunker';
import { MAX_COMMAND_EXCERPT, MAX_ERROR_EXCERPT, capExcerpt, redactField } from './redaction';
import { validateEnvelopeShape } from './validation';

/** Collector authenticates with this header; the value is the raw Collector Credential secret. */
const COLLECTOR_SECRET_HEADER = 'X-Trace-Flow-Collector-Secret';

/** Hard cap on the request body (envelopes with deferred raw bundles are the large case). */
const MAX_INGEST_BYTES = 10 * 1024 * 1024;

// Cloudflare Queues `sendBatch` limits: ≤100 messages AND ≤256 KB total per call (each message also
// ≤128 KB, already enforced upstream by MAX_QUEUE_MESSAGE_BYTES). Grouping by message COUNT alone blew
// the 256 KB total — a few ~124 KB chunked messages exceed it — so we group by cumulative bytes with
// headroom for the batch's own JSON framing.
const QUEUE_SEND_BATCH_MAX_MESSAGES = 100;
const QUEUE_SEND_BATCH_MAX_BYTES = 240 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Group `messages` into `sendBatch`-sized batches that respect BOTH the 100-message and 256 KB-total
 * caps. A single message already fits the per-message limit, so a message larger than the byte budget
 * still ships alone in its own batch rather than being dropped.
 */
function groupForSendBatch(messages: AgentIngestQueueMessage[]): AgentIngestQueueMessage[][] {
  const groups: AgentIngestQueueMessage[][] = [];
  let current: AgentIngestQueueMessage[] = [];
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

    // Cheap pre-check: reject on the declared Content-Length before buffering the body.
    const declaredLength = Number(c.req.header('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_INGEST_BYTES) {
      logger.warn('agent_ingest.payload_too_large', { bytes: declaredLength, source: 'header' });
      return c.json({ error: 'payload_too_large' }, 413);
    }

    const buf = await c.req.arrayBuffer();
    if (buf.byteLength > MAX_INGEST_BYTES) {
      logger.warn('agent_ingest.payload_too_large', { bytes: buf.byteLength });
      return c.json({ error: 'payload_too_large' }, 413);
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

    let envelope: AgentIngestEnvelope;
    try {
      envelope = JSON.parse(bodyText) as AgentIngestEnvelope;
    } catch (err) {
      logger.warn('agent_ingest.invalid_json', { message: String(err) });
      return c.json({ error: 'invalid_envelope' }, 400);
    }
    const shapeError = validateEnvelopeShape(envelope);
    if (shapeError) {
      logger.warn('agent_ingest.invalid_envelope', { missing: shapeError });
      return c.json({ error: 'invalid_envelope' }, 400);
    }
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

    const { success } = await c.env.AGENT_INGEST_LIMITER.limit({ key: credential.orgId });
    if (!success) {
      logger.warn('agent_ingest.rate_limited', { org_id: credential.orgId });
      return c.json({ error: 'rate_limited' }, 429);
    }

    if (isEmpty(facts)) return c.json({ accepted: true, sessions: 0 }, 202);

    reRedact(facts);

    const { queueFacts, sessionPks } = await assembleQueueFacts(facts, batch.source);

    let claims;
    try {
      claims = await claimSessions(
        c.env,
        {
          orgId: credential.orgId,
          userId: credential.userId,
          collectorId: credential.collectorId,
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
      return c.json({ accepted: true, sessions: 0, skipped_conflict: conflicted.size }, 202);
    }

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
    };
    const messages = chunkFacts(base, owned);

    // Enqueue with sendBatch, not N parallel send()s. A multi-session envelope can chunk into hundreds
    // of queue messages; firing that many individual send() subrequests bursts past Cloudflare's
    // queue-write limits (and the Worker subrequest cap) and was the `enqueue_failed` 503 a batched
    // backfill hit. sendBatch packs up to QUEUE_SEND_BATCH_MAX messages per call, so hundreds of sends
    // collapse to a handful. Any failure is a retryable 503; the client re-sends the whole envelope and
    // the consumer dedups on deterministic *_pks, so re-enqueuing messages that already landed is
    // idempotent.
    const groups = groupForSendBatch(messages);
    const sends = await Promise.allSettled(
      groups.map((g) => c.env.AGENT_QUEUE.sendBatch(g.map((body) => ({ body })))),
    );
    const failedGroups = sends.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
    if (failedGroups.length > 0) {
      logger.error('agent_ingest.enqueue_failed', failedGroups[0]?.reason, {
        failed_groups: failedGroups.length,
        groups: groups.length,
        messages: messages.length,
      });
      return c.json({ error: 'enqueue_failed' }, 503);
    }

    logger.info('agent_ingest.accepted', {
      sessions: ownedSessions,
      messages: messages.length,
      skipped_conflict: conflicted.size,
    });
    return c.json(
      { accepted: true, sessions: ownedSessions, skipped_conflict: conflicted.size },
      202,
    );
  } finally {
    await logger.flush();
  }
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
    const navigationPath = redactField(t.navigation_path_hint ?? '');
    t.navigation_path_hint = capExcerpt(navigationPath.value, MAX_COMMAND_EXCERPT);
    const navigationPattern = redactField(t.navigation_pattern_hint ?? '');
    t.navigation_pattern_hint = capExcerpt(navigationPattern.value, MAX_COMMAND_EXCERPT);
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
