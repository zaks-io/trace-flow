import type { DurableObjectStorage } from '@cloudflare/workers-types';
import { CATEGORIES, ROW_IDENTITY_FIELDS, rowIdentity, stableHash, type Category } from './facts';

const PENDING_TABLES = ['pending_facts', 'legacy_pending_facts'] as const;
type PendingTable = (typeof PENDING_TABLES)[number];

interface LegacyPendingRow {
  [key: string]: string | number | null;
  id: number;
  category: string;
  data: string | null;
}

/** Hydrates legacy pending identities before maintenance acquires its durable lock. */
export function backfillPendingFactIdentities(
  storage: DurableObjectStorage,
  orgId: string,
): number {
  let migrated = 0;
  for (const table of PENDING_TABLES) {
    let afterId = 0;
    while (true) {
      const pending = [
        ...storage.sql.exec<LegacyPendingRow>(
          `SELECT id, category, data FROM ${table}
           WHERE id > ? AND sent_at_ms IS NULL AND fact_id IS NULL ORDER BY id LIMIT 1`,
          afterId,
        ),
      ][0];
      if (!pending) break;
      const category = validateCategory(pending.category, table, pending.id);
      const payload = loadPendingPayload(storage, table, pending.id, pending.data);
      const row = parsePendingPayload(payload, table, pending.id);
      if (row.OrgId !== orgId) throw migrationError(table, pending.id, 'organization mismatch');
      if (
        ROW_IDENTITY_FIELDS[category].some(
          (field) => row[field] === undefined || row[field] === null || row[field] === '',
        )
      ) {
        throw migrationError(table, pending.id, 'payload identity is incomplete');
      }
      const factId = rowIdentity(row, ROW_IDENTITY_FIELDS[category]);
      const contentHash = stableHash(row);
      const ledger = [
        ...storage.sql.exec<{ content_hash: string }>(
          `SELECT content_hash FROM fact_ledger WHERE category = ? AND fact_id = ? LIMIT 1`,
          category,
          factId,
        ),
      ][0];
      if (!ledger) throw migrationError(table, pending.id, 'ledger identity is missing');
      if (ledger.content_hash !== contentHash)
        throw migrationError(table, pending.id, 'payload hash does not match the ledger');

      storage.sql.exec(
        `UPDATE ${table} SET fact_id = ?, content_hash = ?
         WHERE id = ? AND sent_at_ms IS NULL AND fact_id IS NULL`,
        factId,
        contentHash,
        pending.id,
      );
      afterId = pending.id;
      migrated++;
    }
  }
  return migrated;
}

function validateCategory(value: string, table: PendingTable, rowId: number): Category {
  if (!(CATEGORIES as readonly string[]).includes(value))
    throw migrationError(table, rowId, 'category is invalid');
  return value as Category;
}

function loadPendingPayload(
  storage: DurableObjectStorage,
  table: PendingTable,
  rowId: number,
  inline: string | null,
): string {
  if (inline) return inline;
  const chunks = [
    ...storage.sql.exec<{ chunk_index: number; data: string }>(
      `SELECT chunk_index, data FROM fact_payload_chunks
       WHERE table_name = ? AND row_id = ? ORDER BY chunk_index`,
      table,
      rowId,
    ),
  ];
  if (chunks.length === 0) throw migrationError(table, rowId, 'payload is missing');
  for (const [index, chunk] of chunks.entries()) {
    if (chunk.chunk_index !== index)
      throw migrationError(table, rowId, 'payload chunk sequence is incomplete');
  }
  return chunks.map((chunk) => chunk.data).join('');
}

function parsePendingPayload(
  payload: string,
  table: PendingTable,
  rowId: number,
): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(payload);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw migrationError(table, rowId, 'payload is invalid JSON');
  }
}

function migrationError(table: PendingTable, rowId: number, reason: string): Error {
  return new Error(`legacy pending fact ${table}:${rowId} cannot be migrated: ${reason}`);
}
