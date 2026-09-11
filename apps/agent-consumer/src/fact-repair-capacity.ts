import type { RecoveryRecord } from '@trace-flow/tinybird-client';
import type { TinybirdRecoveryStore } from '@trace-flow/tinybird-client';
import {
  compactionFailure,
  validateCompactionInput,
  validateInspectionInput,
  type CompactFactRepairDuplicatesInput,
  type CompactFactRepairDuplicatesResult,
  type CompactedFactRepairDuplicate,
  type FactRepairCapacityIssue,
  type FactRepairCompactionCandidate,
  type InspectFactRepairCapacityInput,
  type InspectFactRepairCapacityResult,
} from './fact-repair-capacity-contract';
import {
  errorMessage,
  FactRepairProof,
  sameFactRepairMetadata,
  sameFactRepairRow,
  utf8Length,
  type StoredFactRepair,
} from './fact-repair-proof';

export type {
  CompactFactRepairDuplicatesInput,
  CompactFactRepairDuplicatesResult,
  FactRepairCompactionCandidate,
  InspectFactRepairCapacityInput,
  InspectFactRepairCapacityResult,
  QuiesceFactRepairCapacityInput,
  QuiesceFactRepairCapacityResult,
} from './fact-repair-capacity-contract';
export { validateQuiescenceInput } from './fact-repair-capacity-contract';

const MAX_OPERATION_PAYLOAD_BYTES = 4_000_000;

export function isDatabaseCapacityError(reason: string): boolean {
  return reason.includes('SQLITE_FULL') || reason.includes('Exceeded the maximum database size.');
}

export class FactRepairCapacity {
  private readonly proof: FactRepairProof;

  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly recovery: TinybirdRecoveryStore,
    private readonly assertMutationAllowed: () => void,
  ) {
    this.proof = new FactRepairProof(recovery);
  }

  async inspect(
    orgId: string,
    input: InspectFactRepairCapacityInput,
    startupBlockedReason: string | null,
  ): Promise<Omit<InspectFactRepairCapacityResult, 'queuedRows' | 'alarmScheduledAtMs'>> {
    const { afterRepairId, limit } = validateInspectionInput(input);
    const ids = [
      ...this.storage.sql.exec<{ id: number }>(
        'SELECT id FROM fact_repairs WHERE id > ? ORDER BY id LIMIT ?',
        afterRepairId,
        limit + 1,
      ),
    ];
    const highestRepairId = this.storage.sql
      .exec<{ id: number | null }>('SELECT MAX(id) AS id FROM fact_repairs')
      .one().id;
    const candidates: FactRepairCompactionCandidate[] = [];
    const compactedRepairs: FactRepairCompactionCandidate[] = [];
    const issues: FactRepairCapacityIssue[] = [];
    let scannedRows = 0;
    let scannedDataBytes = 0;
    let inspectedPayloadBytes = 0;
    let legacyRows = 0;
    let emptyRows = 0;
    let lastRepairId: number | null = null;

    for (const { id } of ids.slice(0, limit)) {
      const row = this.load(id);
      const dataBytes = utf8Length(row.data ?? '');
      const size = this.recoverySize(row);
      if (!size.ok) {
        if (scannedRows > 0 && inspectedPayloadBytes + dataBytes > MAX_OPERATION_PAYLOAD_BYTES) {
          break;
        }
        scannedRows++;
        lastRepairId = id;
        scannedDataBytes += dataBytes;
        inspectedPayloadBytes += dataBytes;
        issues.push({ repairId: row.id, reason: size.reason });
        continue;
      }
      const rowInspectionBytes = dataBytes + size.bytes;
      if (
        scannedRows > 0 &&
        inspectedPayloadBytes + rowInspectionBytes > MAX_OPERATION_PAYLOAD_BYTES
      ) {
        break;
      }
      scannedRows++;
      lastRepairId = id;
      scannedDataBytes += dataBytes;
      inspectedPayloadBytes += rowInspectionBytes;
      if (row.recovery_dedupe_key === null) {
        legacyRows++;
        continue;
      }
      if (row.data === '') {
        emptyRows++;
        continue;
      }
      const verification =
        row.data === null
          ? await this.proof.verifyCompacted(row, orgId)
          : await this.proof.verify(row, orgId);
      if (!verification.verified) {
        issues.push({ repairId: row.id, reason: verification.reason });
        continue;
      }
      const proven = {
        repairId: row.id,
        recoveryId: verification.value.recovery.id,
        dataBytes: verification.value.dataBytes,
        proofSha256: verification.value.proofSha256,
      };
      if (row.data === null) {
        if (!sameFactRepairRow(this.load(row.id), row)) {
          issues.push({ repairId: row.id, reason: 'compacted repair changed during inspection' });
          continue;
        }
        compactedRepairs.push(proven);
      } else {
        candidates.push(proven);
      }
    }

    return {
      databaseSizeBytes: this.storage.sql.databaseSize,
      startupBlockedReason,
      highestRepairId,
      scannedRows,
      scannedDataBytes,
      inspectedPayloadBytes,
      legacyRows,
      emptyRows,
      candidateRows: candidates.length,
      candidateBytes: candidates.reduce((total, candidate) => total + candidate.dataBytes, 0),
      candidates,
      compactedRepairs,
      issues,
      nextAfterRepairId:
        lastRepairId !== null && ids.some(({ id }) => id > lastRepairId) ? lastRepairId : null,
    };
  }

  async compact(
    orgId: string,
    input: CompactFactRepairDuplicatesInput,
  ): Promise<CompactFactRepairDuplicatesResult> {
    const candidates = validateCompactionInput(input);
    const databaseSizeBeforeBytes = this.storage.sql.databaseSize;
    const compacted: CompactedFactRepairDuplicate[] = [];
    let inspectedPayloadBytes = 0;
    for (const [index, candidate] of candidates.entries()) {
      const row = this.load(candidate.repairId);
      const size = this.recoverySize(row);
      if (!size.ok) {
        return compactionFailure(
          databaseSizeBeforeBytes,
          this.storage.sql.databaseSize,
          compacted,
          candidates,
          index,
          candidate.repairId,
          size.reason,
        );
      }
      const candidateBytes = utf8Length(row.data ?? '') + size.bytes;
      if (
        compacted.length > 0 &&
        inspectedPayloadBytes + candidateBytes > MAX_OPERATION_PAYLOAD_BYTES
      ) {
        return {
          databaseSizeBeforeBytes,
          databaseSizeAfterBytes: this.storage.sql.databaseSize,
          compacted,
          failure: null,
          remainingRepairIds: candidates.slice(index).map(({ repairId }) => repairId),
          startupBlockedReason: null,
        };
      }
      inspectedPayloadBytes += candidateBytes;
      try {
        compacted.push(await this.compactOne(orgId, candidate, row));
      } catch (error) {
        return compactionFailure(
          databaseSizeBeforeBytes,
          this.storage.sql.databaseSize,
          compacted,
          candidates,
          index,
          candidate.repairId,
          errorMessage(error),
        );
      }
    }
    return {
      databaseSizeBeforeBytes,
      databaseSizeAfterBytes: this.storage.sql.databaseSize,
      compacted,
      failure: null,
      remainingRepairIds: [],
      startupBlockedReason: null,
    };
  }

  compactPreservedRepair(repairId: number, orgId: string, preserved: RecoveryRecord): void {
    const verification = this.proof.verifySync(this.load(repairId), orgId);
    if (
      !verification.verified ||
      verification.value.recovery.id !== preserved.id ||
      verification.value.recovery.payload !== preserved.payload ||
      verification.value.recovery.outcome !== preserved.outcome
    ) {
      throw new Error('preserved repair does not match its inline duplicate');
    }
    this.replaceWithMetadataOnly(verification.value.row);
  }

  private async compactOne(
    orgId: string,
    candidate: { repairId: number; proofSha256: string },
    inspectedRow: StoredFactRepair,
  ): Promise<CompactedFactRepairDuplicate> {
    const verification = await this.proof.verify(inspectedRow, orgId);
    if (!verification.verified) throw new Error(verification.reason);
    const verified = verification.value;
    if (verified.proofSha256 !== candidate.proofSha256) {
      throw new Error('fact repair compaction proof is stale');
    }
    this.assertMutationAllowed();
    const current = this.proof.verifySync(this.load(candidate.repairId), orgId);
    if (
      !current.verified ||
      !sameFactRepairRow(current.value.row, verified.row) ||
      current.value.recovery.id !== verified.recovery.id ||
      current.value.recovery.payload !== verified.recovery.payload ||
      current.value.recovery.outcome !== verified.recovery.outcome
    ) {
      throw new Error('fact repair duplicate changed before compaction');
    }
    this.replaceWithMetadataOnly(current.value.row);
    this.assertCompacted(current.value.row, current.value.recovery);
    return {
      repairId: candidate.repairId,
      recoveryId: current.value.recovery.id,
      clearedInlineBytes: current.value.dataBytes,
      proofSha256: candidate.proofSha256,
    };
  }

  private recoverySize(
    row: StoredFactRepair,
  ): { ok: true; bytes: number } | { ok: false; reason: string } {
    try {
      const size = row.recovery_dedupe_key
        ? this.recovery.repairSizeByDedupeKey(row.recovery_dedupe_key)
        : undefined;
      return {
        ok: true,
        bytes: (size?.payloadBytes ?? 0) + (size?.outcomeBytes ?? 0),
      };
    } catch (error) {
      const reason = errorMessage(error);
      return { ok: false, reason };
    }
  }

  private replaceWithMetadataOnly(expected: StoredFactRepair): void {
    this.storage.transactionSync(() => {
      if (!sameFactRepairRow(this.load(expected.id), expected)) {
        throw new Error('fact repair changed before compaction');
      }
      const deleted = [
        ...this.storage.sql.exec<{ id: number }>(
          'DELETE FROM fact_repairs WHERE id = ? RETURNING id',
          expected.id,
        ),
      ];
      if (deleted.length !== 1 || deleted[0]?.id !== expected.id) {
        throw new Error('fact repair compaction delete failed');
      }
      this.storage.sql.exec(
        `INSERT INTO fact_repairs
         (id, category, fact_id, old_hash, new_hash, seen_at_ms, data, recovery_dedupe_key)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
        expected.id,
        expected.category,
        expected.fact_id,
        expected.old_hash,
        expected.new_hash,
        expected.seen_at_ms,
        expected.recovery_dedupe_key,
      );
    });
  }

  private assertCompacted(expected: StoredFactRepair, expectedRecovery: RecoveryRecord): void {
    const stored = this.load(expected.id);
    if (stored.data !== null || !sameFactRepairMetadata(stored, expected)) {
      throw new Error('fact repair compaction did not preserve metadata');
    }
    const recovery = this.recovery.repairByDedupeKey(expected.recovery_dedupe_key!);
    if (
      recovery?.id !== expectedRecovery.id ||
      recovery.payload !== expectedRecovery.payload ||
      recovery.outcome !== expectedRecovery.outcome
    ) {
      throw new Error('fact repair recovery changed during compaction');
    }
  }

  private load(id: number): StoredFactRepair {
    const row = [
      ...this.storage.sql.exec<StoredFactRepair>(
        `SELECT id, category, fact_id, old_hash, new_hash, seen_at_ms, data, recovery_dedupe_key
         FROM fact_repairs WHERE id = ?`,
        id,
      ),
    ][0];
    if (!row) throw new Error('fact repair not found');
    return row;
  }
}
