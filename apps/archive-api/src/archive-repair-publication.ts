import type { Logger } from '@trace-flow/logging';
import type { ArchiveApiEnv } from './context';
import type { ArchiveScope } from './archive-contract';
import {
  ArchiveContractError,
  assertDigest,
  assertIdentifier,
  assertSafeInteger,
  assertTranscriptPartId,
} from './archive-contract';
import { appendArchiveAuditEvent } from './audit';
import { publishArchiveRepairStatus } from './archive-integrity-status';
import { readLedgerSnapshot } from './archive-ledger-storage';

type RepairPublicationKind =
  | 'attempt_audit'
  | 'failure_audit'
  | 'failure_status'
  | 'success_audit'
  | 'success_status';

interface RepairPublication {
  operationId: string;
  kind: RepairPublicationKind;
  scope: ArchiveScope;
  partId: string;
  snapshotSha256: string;
  relevantCount?: number;
  manifestRootHash?: string;
}

interface PublicationRow {
  [key: string]: string | number | null;
  operation_id: string;
  kind: RepairPublicationKind;
  data: string;
  created_at: number;
}

const ORDER: Record<RepairPublicationKind, number> = {
  attempt_audit: 0,
  failure_audit: 1,
  failure_status: 2,
  success_audit: 3,
  success_status: 4,
};

export function ensureArchiveRepairPublicationTable(storage: DurableObjectStorage): void {
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS ledger_repair_publications (
      operation_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('attempt_audit', 'failure_audit', 'failure_status', 'success_audit', 'success_status')),
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      delivered_at INTEGER,
      PRIMARY KEY (operation_id, kind)
    )
  `);
}

function enqueuePublication(storage: DurableObjectStorage, publication: RepairPublication): void {
  assertIdentifier(publication.operationId, 'archive_repair_invalid');
  assertDigest(publication.snapshotSha256, 'archive_repair_invalid');
  for (const value of [
    publication.scope.orgId,
    publication.scope.userId,
    publication.scope.contributionId,
    publication.scope.sourceSessionId,
  ]) {
    assertIdentifier(value, 'archive_repair_invalid');
  }
  if (publication.scope.source !== 'claude' && publication.scope.source !== 'codex') {
    throw new ArchiveContractError('archive_repair_invalid');
  }
  assertTranscriptPartId(publication.scope.source, publication.partId);
  if (publication.relevantCount !== undefined) {
    assertSafeInteger(publication.relevantCount, 'archive_repair_invalid');
  }
  if (
    publication.manifestRootHash !== undefined &&
    !/^[0-9a-f]{64}$/u.test(publication.manifestRootHash)
  ) {
    throw new ArchiveContractError('archive_repair_invalid');
  }
  ensureArchiveRepairPublicationTable(storage);
  const data = JSON.stringify(publication);
  const existing = [
    ...storage.sql.exec<{ data: string }>(
      'SELECT data FROM ledger_repair_publications WHERE operation_id = ? AND kind = ?',
      publication.operationId,
      publication.kind,
    ),
  ][0];
  if (existing) {
    if (existing.data !== data) throw new ArchiveContractError('ledger_state_corrupt');
    return;
  }
  storage.sql.exec(
    'INSERT INTO ledger_repair_publications (operation_id, kind, data, created_at) VALUES (?, ?, ?, ?)',
    publication.operationId,
    publication.kind,
    data,
    Date.now(),
  );
}

export function enqueueArchiveRepairAttempt(
  storage: DurableObjectStorage,
  input: Omit<RepairPublication, 'kind'>,
): void {
  enqueuePublication(storage, { ...input, kind: 'attempt_audit' });
}

export function enqueueArchiveRepairFailure(
  storage: DurableObjectStorage,
  input: Omit<RepairPublication, 'kind'>,
): void {
  storage.transactionSync(() => {
    enqueuePublication(storage, { ...input, kind: 'failure_audit' });
    enqueuePublication(storage, { ...input, kind: 'failure_status' });
  });
}

export function enqueueArchiveRepairSuccess(
  storage: DurableObjectStorage,
  input: Omit<RepairPublication, 'kind'> & { relevantCount: number; manifestRootHash: string },
): void {
  enqueuePublication(storage, { ...input, kind: 'success_audit' });
  enqueuePublication(storage, { ...input, kind: 'success_status' });
}

export function hasPendingArchiveRepairPublications(storage: DurableObjectStorage): boolean {
  ensureArchiveRepairPublicationTable(storage);
  return (
    [
      ...storage.sql.exec<{ pending: number }>(
        'SELECT EXISTS(SELECT 1 FROM ledger_repair_publications WHERE delivered_at IS NULL) AS pending',
      ),
    ][0]?.pending === 1
  );
}

export function hasPendingArchiveRepairSuccessPublications(storage: DurableObjectStorage): boolean {
  ensureArchiveRepairPublicationTable(storage);
  return (
    [
      ...storage.sql.exec<{ pending: number }>(
        "SELECT EXISTS(SELECT 1 FROM ledger_repair_publications WHERE delivered_at IS NULL AND kind IN ('success_audit', 'success_status')) AS pending",
      ),
    ][0]?.pending === 1
  );
}

export async function deliverPendingArchiveRepairPublications(
  storage: DurableObjectStorage,
  env: Pick<ArchiveApiEnv, 'CONVEX_SITE_URL' | 'ARCHIVE_API_SHARED_SECRET'>,
  logger: Logger,
): Promise<void> {
  ensureArchiveRepairPublicationTable(storage);
  const rows = [
    ...storage.sql.exec<PublicationRow>(
      'SELECT operation_id, kind, data, created_at FROM ledger_repair_publications WHERE delivered_at IS NULL ORDER BY created_at, kind',
    ),
  ].sort(
    (left, right) => left.created_at - right.created_at || ORDER[left.kind] - ORDER[right.kind],
  );
  for (const row of rows) {
    let publication: RepairPublication;
    try {
      publication = JSON.parse(row.data) as RepairPublication;
    } catch {
      throw new ArchiveContractError('ledger_state_corrupt');
    }
    if (publication.operationId !== row.operation_id || publication.kind !== row.kind) {
      throw new ArchiveContractError('ledger_state_corrupt');
    }
    assertIdentifier(publication.operationId, 'ledger_state_corrupt');
    assertDigest(publication.snapshotSha256, 'ledger_state_corrupt');
    assertTranscriptPartId(publication.scope.source, publication.partId);
    const ledgerScope = readLedgerSnapshot(storage).scope;
    if (!ledgerScope || JSON.stringify(ledgerScope) !== JSON.stringify(publication.scope)) {
      throw new ArchiveContractError('ledger_state_corrupt');
    }
    const repairOutcome = publication.kind.startsWith('failure') ? 'failure' : 'success';
    if (publication.kind.endsWith('_audit')) {
      const action =
        publication.kind === 'attempt_audit'
          ? 'operator_repair_attempt'
          : 'operator_repair_outcome';
      await appendArchiveAuditEvent(
        env,
        {
          binding: {
            kind: 'contribution',
            contributionId: publication.scope.contributionId,
          },
          expectedOrgId: publication.scope.orgId,
          action,
          outcome: repairOutcome,
          operationId: `${publication.operationId}:${publication.kind}`,
          targetKind: 'session',
          targetId: publication.scope.sourceSessionId,
          source: publication.scope.source,
          sourceSessionId: publication.scope.sourceSessionId,
          ...(publication.relevantCount === undefined
            ? {}
            : { relevantCount: publication.relevantCount }),
          ...(publication.manifestRootHash === undefined
            ? {}
            : { manifestRootHash: publication.manifestRootHash }),
        },
        logger,
      );
    } else {
      await publishArchiveRepairStatus(env, {
        orgId: publication.scope.orgId,
        userId: publication.scope.userId,
        contributionId: publication.scope.contributionId,
        source: publication.scope.source,
        sourceSessionId: publication.scope.sourceSessionId,
        repairOutcome,
      });
    }
    storage.sql.exec(
      'UPDATE ledger_repair_publications SET delivered_at = ? WHERE operation_id = ? AND kind = ? AND delivered_at IS NULL',
      Date.now(),
      row.operation_id,
      row.kind,
    );
  }
}
