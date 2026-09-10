import { splitUtf8Chunks } from '@trace-flow/tinybird-client';
import type { DurableObjectStorage } from '@cloudflare/workers-types';
import type { AgentFactMaintenance } from './fact-maintenance';
import { compareFactIngestedAt, type Category } from './facts';

const PAYLOAD_CHUNK_BYTES = 900_000;
type PendingTable = 'pending_facts' | 'legacy_pending_facts';

export class PendingFactStore {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly maintenance: AgentFactMaintenance,
  ) {}

  insert(
    table: PendingTable,
    category: Category,
    factId: string,
    contentHash: string,
    data: string,
    createdAtMs: number,
  ): void {
    const oversized = utf8Bytes(data) > PAYLOAD_CHUNK_BYTES;
    this.storage.sql.exec(
      `INSERT INTO ${table} (category, fact_id, content_hash, data, created_at_ms)
       VALUES (?, ?, ?, ?, ?)`,
      category,
      factId,
      contentHash,
      oversized ? '' : data,
      createdAtMs,
    );
    if (!oversized) return;
    const rowId = this.storage.sql
      .exec<{ id: number }>('SELECT last_insert_rowid() AS id')
      .one().id;
    this.storeChunks(table, rowId, data);
  }

  coalesce(
    category: Category,
    factId: string,
    contentHash: string,
    data: string,
    currentData: string,
    cleanTarget: number | null,
    legacyTarget: number | null,
  ): 'updated' | 'stale' | 'unavailable' {
    if (cleanTarget === null || legacyTarget === null) return 'unavailable';
    const targets: PendingTable[] = [];
    if (cleanTarget === 1) targets.push('pending_facts');
    if (legacyTarget === 1) targets.push('legacy_pending_facts');
    const pending = targets.map((table) => ({
      table,
      ids: this.coalescibleRows(table, category, factId),
    }));
    if (pending.some(({ ids }) => ids.length !== 1)) return 'unavailable';
    if (compareFactIngestedAt(JSON.parse(data), JSON.parse(currentData)) < 0) return 'stale';
    this.maintenance.storeLedgerPayload(category, factId, data);
    this.storage.sql.exec(
      'UPDATE fact_ledger SET content_hash = ? WHERE category = ? AND fact_id = ?',
      contentHash,
      category,
      factId,
    );
    for (const { table, ids } of pending) this.replace(table, ids[0]!, contentHash, data);
    return 'updated';
  }

  private coalescibleRows(table: PendingTable, category: Category, factId: string): number[] {
    return [
      ...this.storage.sql.exec<{ id: number }>(
        `SELECT id FROM ${table} AS p
         WHERE category = ? AND fact_id = ? AND sent_at_ms IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM recovery_items AS i JOIN recovery_records AS r ON r.id = i.recovery_id
             WHERE i.row_id = p.id AND i.target_key = ? || ':' || p.category
               AND r.state IN ('in_flight', 'blocked')
           )
         ORDER BY id LIMIT 2`,
        category,
        factId,
        table,
      ),
    ].map((row) => row.id);
  }

  private replace(table: PendingTable, rowId: number, contentHash: string, data: string): void {
    this.storage.sql.exec(
      'DELETE FROM fact_payload_chunks WHERE table_name = ? AND row_id = ?',
      table,
      rowId,
    );
    const oversized = utf8Bytes(data) > PAYLOAD_CHUNK_BYTES;
    this.storage.sql.exec(
      `UPDATE ${table} SET content_hash = ?, data = ? WHERE id = ?`,
      contentHash,
      oversized ? '' : data,
      rowId,
    );
    if (oversized) this.storeChunks(table, rowId, data);
  }

  private storeChunks(table: PendingTable, rowId: number, data: string): void {
    for (const [index, chunk] of splitUtf8Chunks(data, PAYLOAD_CHUNK_BYTES).entries()) {
      this.storage.sql.exec(
        `INSERT INTO fact_payload_chunks (table_name, row_id, chunk_index, data)
         VALUES (?, ?, ?, ?)`,
        table,
        rowId,
        index,
        chunk,
      );
    }
  }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
