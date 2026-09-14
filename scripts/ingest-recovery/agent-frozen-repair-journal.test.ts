import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RecoveryRecord } from '../../packages/tinybird-client/src/recovery';
import type { ReconcileFrozenRepairInput } from '../../apps/agent-consumer/src/frozen-repair-reconciliation-contract';
import {
  FrozenRepairReconciliationJournal,
  type FrozenRepairJournalFence,
} from './agent-frozen-repair-journal';

const fence: FrozenRepairJournalFence = {
  orgId: 'org-a',
  migrationProofSha256: 'a'.repeat(64),
  deliverySequence: 3,
  oldestDay: '2025-09-14',
  todayDay: '2026-09-13',
  fullVerificationSha256: 'b'.repeat(64),
};

test('durably resumes an exact private journal and confirms its proof', () => {
  const directory = mkdtempSync(join(tmpdir(), 'trace-flow-repair-journal-'));
  const path = join(directory, 'journal.sqlite');
  const entry = journalEntry(7);
  let journal = new FrozenRepairReconciliationJournal(path, fence);
  try {
    journal.appendPage([entry], null);
    journal.assertReadyToMutate();
    expect(journal.nextPendingBatch()).toEqual([entry.proof]);
    expect(statSync(path).mode & 0o077).toBe(0);
    journal.close();

    journal = new FrozenRepairReconciliationJournal(path, fence);
    journal.assertReadyToMutate();
    expect(journal.nextPendingBatch()).toEqual([entry.proof]);
    journal.confirm([entry.proof], {
      databaseSizeBeforeBytes: 100,
      databaseSizeAfterBytes: 100,
      releasedRecoveryBytes: 200,
      hydratedRepairBytes: 50,
      tombstoneBytes: 20,
    });
    expect(journal.nextPendingBatch()).toEqual([]);
    expect(journal.report()).toEqual({
      total: 1,
      exact: 1,
      superseded: 0,
      expired: 0,
      storage: {
        batches: 1,
        databaseSizeBeforeBytes: 100,
        databaseSizeAfterBytes: 100,
        releasedRecoveryBytes: 200,
        hydratedRepairBytes: 50,
        tombstoneBytes: 20,
      },
    });
  } finally {
    journal.close();
    rmSync(directory, { recursive: true });
  }
});

test('fails closed for a partial or corrupt journal', () => {
  const directory = mkdtempSync(join(tmpdir(), 'trace-flow-repair-corrupt-'));
  const path = join(directory, 'journal.sqlite');
  const journal = new FrozenRepairReconciliationJournal(path, fence);
  try {
    expect(() => journal.assertReadyToMutate()).toThrow('inventory is incomplete');
    journal.appendPage([journalEntry(8)], null);
    journal.db.query("UPDATE repairs SET record_json='{}' WHERE recovery_id=8").run();
    expect(() => journal.assertReadyToMutate()).toThrow('is corrupt');
  } finally {
    journal.close();
    rmSync(directory, { recursive: true });
  }
});

test('fails closed for corrupt storage metadata', () => {
  const directory = mkdtempSync(join(tmpdir(), 'trace-flow-repair-metadata-'));
  const path = join(directory, 'journal.sqlite');
  const journal = new FrozenRepairReconciliationJournal(path, fence);
  try {
    journal.appendPage([journalEntry(9)], null);
    journal.db.query("UPDATE metadata SET data='NaN' WHERE key='released_recovery_bytes'").run();
    expect(() => journal.assertReadyToMutate()).toThrow(
      'metadata released_recovery_bytes is corrupt',
    );
  } finally {
    journal.close();
    rmSync(directory, { recursive: true });
  }
});

test('does not overwrite an existing non-journal file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'trace-flow-repair-existing-'));
  const path = join(directory, 'journal.sqlite');
  writeFileSync(path, 'private operator notes', { mode: 0o600 });
  chmodSync(path, 0o600);
  try {
    expect(() => new FrozenRepairReconciliationJournal(path, fence)).toThrow(
      'Refusing to overwrite a non-journal file',
    );
    expect(readFileSync(path, 'utf8')).toBe('private operator notes');
  } finally {
    rmSync(directory, { recursive: true });
  }
});

function journalEntry(recoveryId: number): {
  record: RecoveryRecord;
  proof: ReconcileFrozenRepairInput;
} {
  const payload = JSON.stringify({ OrgId: fence.orgId, value: recoveryId });
  const outcome = JSON.stringify({ recoveryId });
  const rowSha256 = 'c'.repeat(64);
  return {
    record: {
      id: recoveryId,
      kind: 'repair',
      state: 'blocked',
      classification: 'changed',
      target: null,
      payload,
      outcome,
      createdAtMs: 1,
      resolvedAtMs: null,
      resolution: null,
      resolutionReason: null,
    },
    proof: {
      recoveryId,
      expectedPayloadSha256: sha256(payload),
      expectedOutcomeSha256: sha256(outcome),
      orgId: fence.orgId,
      category: 'messages',
      factId: `org-a\u001fsession\u001f${recoveryId}`,
      migrationProofSha256: fence.migrationProofSha256,
      deliverySequence: fence.deliverySequence,
      oldestDay: fence.oldestDay,
      todayDay: fence.todayDay,
      fullVerificationSha256: fence.fullVerificationSha256,
      disposition: 'exact',
      sourceEventDay: fence.todayDay,
      sourceIngestedAtMs: 1,
      sourceRowSha256: rowSha256,
      canonical: {
        eventDay: fence.todayDay,
        deliverySequence: fence.deliverySequence,
        contentHash: 'd'.repeat(64),
        ingestedAtMs: 1,
        rowSha256,
      },
    },
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
