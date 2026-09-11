/**
 * Archive API Worker. Owns the archive.trace-flow.dev authorization boundary:
 * Collector Credential + current enrollment for uploads, and a fail-closed
 * Archive Export Grant placeholder for reads and deletion. Upload persistence
 * is serialized by the Archive Session Ledger Durable Object.
 */
import * as Sentry from '@sentry/cloudflare';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { Hono } from 'hono';
import type { ArchiveApiEnv } from './context';
import { createArchiveApiSentryOptions } from './sentry';
import { handleCollectorEnrollment } from './collector-enrollment-handler';
import { handleCollectorPolicy } from './collector-policy-handler';
import {
  handleDeleteArchive,
  handleDeleteContribution,
  handleExport,
  handleHealthz,
  handleRotateKey,
  handleRotationHealth,
  handleUpload,
} from './handler';
import {
  handleBeginArchiveErasure,
  handleEraseArchiveLedgers,
  handleFinishArchiveErasure,
} from './archive-erasure';
import {
  ArchiveContractError,
  assertArchiveSource,
  assertIdentifier,
  assertTranscriptPartId,
  type ArchiveScope,
} from './archive-contract';
export { ArchiveSessionLedger } from './archive-ledger';
export { StorageBudget } from './archive-storage-budget';

export const app = new Hono<{ Bindings: ArchiveApiEnv }>();

function recoveryScope(value: unknown): ArchiveScope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ArchiveContractError('archive_repair_invalid');
  }
  const scope = value as Record<string, unknown>;
  for (const field of ['orgId', 'userId', 'contributionId', 'sourceSessionId']) {
    assertIdentifier(scope[field], 'archive_repair_invalid');
  }
  assertArchiveSource(scope.source);
  return {
    orgId: scope.orgId as string,
    userId: scope.userId as string,
    contributionId: scope.contributionId as string,
    source: scope.source,
    sourceSessionId: scope.sourceSessionId as string,
  };
}

export class ArchiveRecovery extends WorkerEntrypoint<ArchiveApiEnv> {
  private ledger(scope: ArchiveScope) {
    const id = this.env.ARCHIVE_SESSION_LEDGER.idFromName(
      JSON.stringify([scope.orgId, scope.contributionId, scope.source, scope.sourceSessionId]),
    );
    return this.env.ARCHIVE_SESSION_LEDGER.get(id);
  }

  inspectArchivePart(partId: string, options: { scope?: unknown }): Promise<unknown> {
    const scope = recoveryScope(options?.scope);
    assertTranscriptPartId(scope.source, partId);
    return this.ledger(scope).inspectArchivePart({ scope, partId });
  }

  applyArchiveRepairChunk(partId: string, options: Record<string, unknown>): Promise<unknown> {
    const scope = recoveryScope(options?.scope);
    assertTranscriptPartId(scope.source, partId);
    const upload = options?.upload as { checkpoint?: { source_transcript_part_id?: unknown } };
    if (upload?.checkpoint?.source_transcript_part_id !== partId) {
      throw new ArchiveContractError('archive_repair_invalid');
    }
    return this.ledger(scope).applyArchiveRepairChunk(options as never);
  }

  verifyArchiveRepairPage(partId: string, options: Record<string, unknown>): Promise<unknown> {
    const scope = recoveryScope(options?.scope);
    assertTranscriptPartId(scope.source, partId);
    return this.ledger(scope).verifyArchiveRepairPage(options as never);
  }

  finalizeArchiveRepair(partId: string, options: Record<string, unknown>): Promise<unknown> {
    const scope = recoveryScope(options?.scope);
    assertTranscriptPartId(scope.source, partId);
    return this.ledger(scope).finalizeArchiveRepair({ ...options, partId } as never);
  }
}

app.get('/healthz', handleHealthz);

app.get('/v1/archive/policy', handleCollectorPolicy);
app.post('/v1/archive/enrollments', handleCollectorEnrollment);
app.post('/v1/archive/uploads', handleUpload);

app.get('/v1/archive/exports', handleExport);
app.post('/v1/archive/exports', handleExport);

app.delete('/v1/archive/contributions/:contributionId', handleDeleteContribution);
app.delete('/v1/archive', handleDeleteArchive);

app.post('/v1/archive/key-rotations', handleRotateKey);
app.get('/v1/archive/key-rotations/:orgId', handleRotationHealth);

app.post('/internal/archive-erasure/begin', handleBeginArchiveErasure);
app.post('/internal/archive-erasure/ledgers', handleEraseArchiveLedgers);
app.post('/internal/archive-erasure/finish', handleFinishArchiveErasure);

export default Sentry.withSentry(createArchiveApiSentryOptions, app);
