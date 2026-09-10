import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, openSync } from 'node:fs';
import {
  CATEGORIES,
  DATASOURCES,
  LEGACY_DATASOURCES,
  ROW_IDENTITY_FIELDS,
  compareFactIngestedAt,
  factIngestedAtMs,
  rowIdentity,
  stableHash,
  type Category,
} from '../../apps/agent-consumer/src/facts';

export { CATEGORIES, DATASOURCES, LEGACY_DATASOURCES, ROW_IDENTITY_FIELDS, stableHash };
export type { Category };
export type Row = Record<string, unknown>;
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const quote = (value: string) =>
  `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;

export function identity(category: Category, row: Row, org: string): string {
  if (row.OrgId !== org || ROW_IDENTITY_FIELDS[category].some((key) => !row[key])) {
    throw new Error(`Invalid organization or identity in ${category}`);
  }
  return rowIdentity(row, ROW_IDENTITY_FIELDS[category]);
}

export class AgentSnapshot {
  readonly db: Database;
  constructor(path: string, create = false) {
    if (create) {
      closeSync(openSync(path, 'wx', 0o600));
      chmodSync(path, 0o600);
    }
    this.db = new Database(path, { readonly: !create, strict: true });
    if (create)
      this.db.exec(`
      PRAGMA synchronous=FULL;
      CREATE TABLE originals (datasource TEXT, data TEXT NOT NULL);
      CREATE TABLE desired (category TEXT, fact_id TEXT, data TEXT NOT NULL,
        ledger TEXT, old_hash TEXT, PRIMARY KEY(category, fact_id));
      CREATE TABLE recovery (id INTEGER PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE targets (category TEXT, fact_id TEXT, datasource TEXT, PRIMARY KEY(category, fact_id, datasource));
      CREATE TABLE metadata (key TEXT PRIMARY KEY, data TEXT NOT NULL);
    `);
  }

  meta(key: string, value?: unknown): any {
    if (value !== undefined) {
      this.db
        .query('INSERT OR REPLACE INTO metadata VALUES (?, ?)')
        .run(key, JSON.stringify(value));
      return value;
    }
    const result = this.db
      .query<{ data: string }, [string]>('SELECT data FROM metadata WHERE key=?')
      .get(key);
    if (!result) throw new Error(`Snapshot metadata missing: ${key}`);
    return JSON.parse(result.data);
  }

  preserve(category: Category, datasource: string, row: Row, org: string): void {
    factIngestedAtMs(row);
    const key = identity(category, row, org);
    this.db.query('INSERT INTO originals VALUES (?, ?)').run(datasource, JSON.stringify(row));
    this.target(category, key, datasource);
    this.target(category, key, DATASOURCES[category]);
    const existing = this.get(category, key);
    // Cloud duplicates have no sequence beyond IngestedAt. Equal-time conflicting copies need review.
    if (existing) {
      const prior = JSON.parse(existing.data);
      const versionOrder = compareFactIngestedAt(prior, row);
      if (versionOrder > 0) return;
      const common = Object.keys(row).filter((key) => key in prior);
      const shared = (value: Row) => Object.fromEntries(common.map((key) => [key, value[key]]));
      if (versionOrder === 0 && stableHash(shared(prior)) !== stableHash(shared(row))) {
        throw new Error(`Conflicting equal-time cloud versions in ${category}; snapshot preserved`);
      }
    }
    this.db
      .query('INSERT OR REPLACE INTO desired VALUES (?, ?, ?, NULL, NULL)')
      .run(
        category,
        key,
        JSON.stringify({ ...(existing ? JSON.parse(existing.data) : {}), ...row }),
      );
  }

  get(category: Category, factId: string) {
    return this.db
      .query<
        { data: string; ledger: string | null; old_hash: string | null },
        [string, string]
      >('SELECT data, ledger, old_hash FROM desired WHERE category=? AND fact_id=?')
      .get(category, factId);
  }

  overlay(category: Category, factId: string, payload: string, oldHash: string, org: string) {
    const row = JSON.parse(payload);
    factIngestedAtMs(row);
    if (identity(category, row, org) !== factId) throw new Error('Ledger identity mismatch');
    this.target(category, factId, DATASOURCES[category]);
    const prior = this.get(category, factId);
    const priorRow = prior ? JSON.parse(prior.data) : null;
    const usePrior = priorRow !== null && compareFactIngestedAt(row, priorRow) < 0;
    // Preserve populated historical columns that were absent in an older collector payload.
    const stored = priorRow === null || usePrior ? (priorRow ?? row) : { ...priorRow, ...row };
    const ledger = usePrior ? (prior!.ledger ?? prior!.data) : payload;
    this.db
      .query('INSERT OR REPLACE INTO desired VALUES (?, ?, ?, ?, ?)')
      .run(category, factId, JSON.stringify(stored), ledger, oldHash);
  }

  target(category: Category, factId: string, datasource: string) {
    this.db
      .query('INSERT OR IGNORE INTO targets VALUES (?, ?, ?)')
      .run(category, factId, datasource);
  }

  rows(category: Category, datasource = DATASOURCES[category] as string) {
    return this.db
      .query<
        { fact_id: string; data: string; ledger: string | null; old_hash: string | null },
        [string, string]
      >('SELECT d.fact_id, data, ledger, old_hash FROM desired d JOIN targets t ON d.category=t.category AND d.fact_id=t.fact_id WHERE d.category=? AND t.datasource=? ORDER BY d.fact_id')
      .iterate(category, datasource);
  }

  fingerprint(): string {
    const hash = createHash('sha256');
    for (const category of CATEGORIES) {
      for (const row of this.rows(category))
        hash.update(JSON.stringify([category, row.fact_id, row.data]) + '\n');
    }
    return hash.digest('hex');
  }
}

export function* batches<T>(items: Iterable<T>, maxBytes = 850_000, maxRows = 100): Generator<T[]> {
  let group: T[] = [];
  let size = 2;
  for (const item of items) {
    const bytes = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (group.length && (size + bytes > maxBytes || group.length >= maxRows)) {
      yield group;
      group = [];
      size = 2;
    }
    group.push(item);
    size += bytes;
  }
  if (group.length) yield group;
}
