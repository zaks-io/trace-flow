import { DurableObject } from 'cloudflare:workers';
import type { ArchiveApiEnv } from './context';
import { MAX_ARCHIVE_COMMIT_BYTES, readBoundedJson } from './archive-request';
import { ArchiveContractError } from './archive-contract';
import { commitArchiveSession } from './archive-ledger-commit';
import { assertIncomingObservationCount } from './archive-validation';
import { statusFor } from './archive-ledger-support';

export class ArchiveSessionLedger extends DurableObject<ArchiveApiEnv> {
  private commitQueue: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: ArchiveApiEnv) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS ledger_state (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)',
    );
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS ledger_elements (sequence INTEGER PRIMARY KEY, data TEXT NOT NULL)',
    );
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS ledger_ranges (sequence INTEGER PRIMARY KEY, data TEXT NOT NULL)',
    );
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS ledger_scans (part_id TEXT PRIMARY KEY, data TEXT NOT NULL)',
    );
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS ledger_scan_fingerprints (part_id TEXT NOT NULL, fingerprint_index INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (part_id, fingerprint_index))',
    );
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS ledger_record_versions (version_key TEXT PRIMARY KEY, part_id TEXT NOT NULL, record_identity TEXT NOT NULL, content_hash TEXT NOT NULL, sequence INTEGER NOT NULL)',
    );
    this.ctx.storage.sql.exec(
      'CREATE INDEX IF NOT EXISTS ledger_record_versions_identity ON ledger_record_versions (part_id, record_identity)',
    );
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS pending_intents (intent_hash TEXT PRIMARY KEY, status TEXT NOT NULL, base_element_count INTEGER NOT NULL, base_chain_head TEXT NOT NULL)',
    );
    this.ctx.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS pending_intents_active_status ON pending_intents (status) WHERE status IN ('building', 'ready')",
    );
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS pending_intent_metadata (intent_hash TEXT NOT NULL, part_index INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (intent_hash, part_index))',
    );
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS pending_intent_parts (intent_hash TEXT NOT NULL, object_index INTEGER NOT NULL, part_index INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (intent_hash, object_index, part_index))',
    );
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/commit') {
      return Response.json({ error: 'not_found' }, { status: 404 });
    }
    try {
      const body = await readBoundedJson(
        request,
        MAX_ARCHIVE_COMMIT_BYTES,
        'archive_commit_too_large',
      );
      const upload =
        typeof body === 'object' && body !== null && !Array.isArray(body)
          ? (body as Record<string, unknown>).upload
          : undefined;
      assertIncomingObservationCount(upload);
      const turn = this.commitQueue.then(() =>
        commitArchiveSession(this.ctx.storage, this.env, body),
      );
      this.commitQueue = turn.then(
        () => undefined,
        () => undefined,
      );
      const acknowledgement = await turn;
      return Response.json(acknowledgement);
    } catch (error) {
      const errorClass =
        error instanceof ArchiveContractError ? error.errorClass : 'archive_commit_failed';
      if (!(error instanceof ArchiveContractError)) {
        const diagnosticClass = error instanceof Error ? error.name : 'unknown_error';
        console.error(
          JSON.stringify({ event: 'archive_ledger.commit_failed', errorClass: diagnosticClass }),
        );
      }
      return Response.json({ error: errorClass }, { status: statusFor(errorClass) });
    }
  }
}
