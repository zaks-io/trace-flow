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

/** Collector authenticates with this header; the value is the raw Collector Credential secret. */
const COLLECTOR_SECRET_HEADER = 'X-Trace-Flow-Collector-Secret';

/** Hard cap on the request body (envelopes with deferred raw bundles are the large case). */
const MAX_INGEST_BYTES = 10 * 1024 * 1024;

const decoder = new TextDecoder();

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

    let envelope: AgentIngestEnvelope;
    try {
      envelope = JSON.parse(decoder.decode(buf)) as AgentIngestEnvelope;
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

    // allSettled so a partial enqueue is visible (succeeded vs failed). Any failure is a retryable
    // 503; the client re-sends the whole batch and the consumer dedups on the deterministic *_pks,
    // so re-enqueuing the messages that did land is idempotent.
    const sends = await Promise.allSettled(messages.map((m) => c.env.AGENT_QUEUE.send(m)));
    const failed = sends.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
    if (failed.length > 0) {
      logger.error('agent_ingest.enqueue_failed', failed[0]?.reason, {
        failed: failed.length,
        succeeded: messages.length - failed.length,
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

const FACT_CATEGORIES = [
  'messages',
  'tool_events',
  'file_events',
  'capability_snapshots',
  'pull_request_links',
] as const;
const BATCH_STRING_FIELDS = [
  'source',
  'parser_version',
  'desktop_version',
  'collector_batch_id',
] as const;

/**
 * Structural guard at the trust boundary. The truthy `batch`/`facts` check is not enough — a
 * well-formed-but-empty `{batch:{},facts:{}}` would pass it and then throw downstream (semver parse
 * on an undefined version, `.length` on a missing fact array) into a 500. This rejects those with a
 * precise 400. It is not full schema validation (the consumer's Tinybird quarantine is the schema
 * gate); it only asserts the fields this handler dereferences. Returns the first offending field, or
 * `null` if the shape is usable.
 */
function validateEnvelopeShape(envelope: AgentIngestEnvelope | undefined): string | null {
  if (!envelope?.batch || typeof envelope.batch !== 'object') return 'batch';
  if (!envelope.facts || typeof envelope.facts !== 'object') return 'facts';
  for (const field of BATCH_STRING_FIELDS) {
    if (typeof envelope.batch[field] !== 'string') return `batch.${field}`;
  }
  for (const category of FACT_CATEGORIES) {
    if (!Array.isArray(envelope.facts[category])) return `facts.${category}`;
  }
  return null;
}

function isEmpty(facts: AgentIngestQueueFacts | AgentIngestEnvelope['facts']): boolean {
  return (
    facts.messages.length === 0 &&
    facts.tool_events.length === 0 &&
    facts.file_events.length === 0 &&
    facts.capability_snapshots.length === 0 &&
    facts.pull_request_links.length === 0
  );
}

/** Re-runs the redaction backstop over the only free-text fields, capping excerpts to their column. */
function reRedact(facts: AgentIngestEnvelope['facts']): void {
  for (const t of facts.tool_events) {
    const cmd = redactField(t.command_excerpt);
    t.command_excerpt = capExcerpt(cmd.value, MAX_COMMAND_EXCERPT);
    const errExcerpt = redactField(t.error_excerpt);
    t.error_excerpt = capExcerpt(errExcerpt.value, MAX_ERROR_EXCERPT);
    t.dropped_sensitive = (t.dropped_sensitive ?? 0) + cmd.dropped + errExcerpt.dropped;
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
  };
}
