import { DurableObject } from 'cloudflare:workers';
import type { ArchiveApiEnv } from './context';
import { MAX_ARCHIVE_COMMIT_BYTES, readBoundedJson } from './archive-request';
import { ArchiveContractError } from './archive-contract';
import { commitArchiveSession } from './archive-ledger-commit';
import { assertIncomingObservationCount } from './archive-validation';
import { statusFor } from './archive-ledger-support';
import {
  ArchiveSessionIntegrityError,
  ensureSessionIntegrityTable,
} from './archive-session-integrity';
import {
  armLedgerRecovery,
  resumeLedgerRecovery,
  scheduleLedgerRecovery,
} from './archive-ledger-recovery';
import { ensurePendingReleaseSchema } from './archive-ledger-release-outbox';

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
      "CREATE INDEX IF NOT EXISTS pending_intents_active_status_v2 ON pending_intents (status) WHERE status IN ('building', 'ready', 'write_authorized')",
    );
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS pending_intent_metadata (intent_hash TEXT NOT NULL, part_index INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (intent_hash, part_index))',
    );
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS pending_intent_parts (intent_hash TEXT NOT NULL, object_index INTEGER NOT NULL, part_index INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (intent_hash, object_index, part_index))',
    );
    ensurePendingReleaseSchema(this.ctx.storage);
    ensureSessionIntegrityTable(this.ctx.storage);
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
      const turn = this.commitQueue.then(async () => {
        await armLedgerRecovery(this.ctx.storage);
        const result = await commitArchiveSession(this.ctx.storage, this.env, body).then(
          (acknowledgement) => ({ acknowledgement }),
          (error: unknown) => ({ error }),
        );
        try {
          await scheduleLedgerRecovery(this.ctx.storage);
        } catch (recoveryError) {
          if ('error' in result) throw result.error;
          throw recoveryError;
        }
        return result;
      });
      this.commitQueue = turn.then(
        () => undefined,
        () => undefined,
      );
      const result = await turn;
      if ('error' in result) throw result.error;
      return Response.json(result.acknowledgement);
    } catch (error) {
      if (error instanceof ArchiveSessionIntegrityError) {
        return Response.json(
          {
            error: error.errorClass,
            source: error.failure.source,
            source_session_id: error.failure.sourceSessionId,
            error_class: error.failure.errorClass,
            operation_id: error.failure.operationId,
            newly_recorded: error.newlyRecorded,
          },
          { status: 409 },
        );
      }
      if (error instanceof ArchiveContractError) {
        return Response.json({ error: error.errorClass }, { status: statusFor(error.errorClass) });
      }
      const diagnosticClass = error instanceof Error ? error.name : 'unknown_error';
      console.error(
        JSON.stringify({ event: 'archive_ledger.commit_failed', errorClass: diagnosticClass }),
      );
      throw error;
    }
  }

  async alarm(): Promise<void> {
    const turn = this.commitQueue.then(async () => {
      let retry = true;
      try {
        await resumeLedgerRecovery(this.ctx.storage, this.env);
      } catch (error) {
        if (
          error instanceof ArchiveContractError &&
          error.errorClass === 'storage_object_metadata_mismatch'
        ) {
          retry = false;
        }
        console.error(
          JSON.stringify({
            event: 'archive_ledger.recovery_failed',
            errorClass: error instanceof Error ? error.name : 'unknown_error',
          }),
        );
      } finally {
        if (retry) await scheduleLedgerRecovery(this.ctx.storage);
        else await this.ctx.storage.deleteAlarm();
      }
    });
    this.commitQueue = turn.then(
      () => undefined,
      () => undefined,
    );
    await turn;
  }
}
