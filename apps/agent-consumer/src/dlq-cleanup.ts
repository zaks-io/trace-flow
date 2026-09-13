import type { DurableObjectStorage } from '@cloudflare/workers-types';
import type { TinybirdRecoveryStore } from '@trace-flow/tinybird-client';
import { sha256Hex } from '@trace-flow/utils';
import { dlqPayloadOrgId } from './fact-batcher-helpers';

export class DlqCleanup {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly recovery: TinybirdRecoveryStore,
  ) {}

  async discard(recoveryId: number, expectedPayloadSha256: string): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(expectedPayloadSha256)) {
      throw new Error('invalid expected DLQ payload hash');
    }
    const record = this.recovery.get(recoveryId);
    if (record.kind !== 'dlq') throw new Error('recovery record is not a DLQ message');
    if ((await sha256Hex(record.payload)) !== expectedPayloadSha256) {
      throw new Error('DLQ payload hash does not match');
    }
    this.storage.transactionSync(() => {
      const current = this.recovery.get(recoveryId);
      if (current.kind !== 'dlq' || current.payload !== record.payload) {
        throw new Error('DLQ record changed before deletion');
      }
      this.deleteRecords([recoveryId]);
    });
  }

  discardOrganization(
    orgId: string,
    input: { afterId?: number; limit?: number } = {},
  ): { deleted: number; nextAfterId: number | null } {
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(orgId)) throw new Error('invalid DLQ organization');
    const afterId = input.afterId ?? 0;
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(afterId) || afterId < 0) throw new Error('invalid DLQ cursor');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('invalid DLQ limit');
    }
    const rows = [
      ...this.storage.sql.exec<{ id: number }>(
        `SELECT id FROM recovery_records
         WHERE kind = 'dlq' AND id > ? ORDER BY id LIMIT ?`,
        afterId,
        limit + 1,
      ),
    ];
    const page = rows.slice(0, limit);
    const ids = page
      .filter(({ id }) => dlqPayloadOrgId(this.recovery.get(id).payload) === orgId)
      .map(({ id }) => id);
    this.storage.transactionSync(() => this.deleteRecords(ids));
    return {
      deleted: ids.length,
      nextAfterId: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  private deleteRecords(ids: number[]): void {
    for (const id of ids) {
      this.storage.sql.exec('DELETE FROM recovery_items WHERE recovery_id = ?', id);
      this.storage.sql.exec('DELETE FROM recovery_payload_chunks WHERE recovery_id = ?', id);
      this.storage.sql.exec('DELETE FROM recovery_outcome_chunks WHERE recovery_id = ?', id);
      this.storage.sql.exec('DELETE FROM recovery_records WHERE id = ? AND kind = ?', id, 'dlq');
    }
  }
}
