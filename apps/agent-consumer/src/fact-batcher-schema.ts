import type { DurableObjectStorage } from '@cloudflare/workers-types';
import type { TinybirdRecoveryStore } from '@trace-flow/tinybird-client';
import type { AgentFactMaintenance } from './fact-maintenance';

export function initializeFactBatcherSchema(
  storage: DurableObjectStorage,
  recovery: TinybirdRecoveryStore,
  maintenance: AgentFactMaintenance,
): void {
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS fact_ledger (
      category TEXT NOT NULL,
      fact_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      first_seen_at_ms INTEGER NOT NULL,
      data TEXT,
      PRIMARY KEY (category, fact_id)
    )
  `);
  ensureColumn(storage, 'fact_ledger', 'data', 'TEXT');
  ensureColumn(storage, 'fact_ledger', 'clean_target', 'INTEGER');
  ensureColumn(storage, 'fact_ledger', 'legacy_target', 'INTEGER');
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS fact_repairs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      fact_id TEXT NOT NULL,
      old_hash TEXT NOT NULL,
      new_hash TEXT NOT NULL,
      seen_at_ms INTEGER NOT NULL,
      data TEXT
    )
  `);
  ensureColumn(storage, 'fact_repairs', 'data', 'TEXT');
  ensureColumn(storage, 'fact_repairs', 'recovery_dedupe_key', 'TEXT');
  storage.sql.exec(
    `CREATE INDEX IF NOT EXISTS idx_fact_repairs_lookup
     ON fact_repairs(category, fact_id, old_hash, new_hash)`,
  );
  for (const table of ['pending_facts', 'legacy_pending_facts']) {
    storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS ${table} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        sent_at_ms INTEGER
      )
    `);
    ensureColumn(storage, table, 'sent_at_ms', 'INTEGER');
    ensureColumn(storage, table, 'fact_id', 'TEXT');
    ensureColumn(storage, table, 'content_hash', 'TEXT');
    storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_${table}_category_id ON ${table}(category, id)`,
    );
    storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_${table}_identity ON ${table}(category, fact_id, id)`,
    );
  }
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS fact_payload_chunks (
      table_name TEXT NOT NULL,
      row_id INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (table_name, row_id, chunk_index)
    )
  `);
  recovery.initializeSchema();
  maintenance.initialize();
}

function ensureColumn(
  storage: DurableObjectStorage,
  table: string,
  column: string,
  definition: string,
): void {
  const existing = [
    ...storage.sql.exec<{ name: string }>(
      `SELECT name FROM pragma_table_info('${table}') WHERE name = ?`,
      column,
    ),
  ];
  if (existing.length === 0) {
    storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
