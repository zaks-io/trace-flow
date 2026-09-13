import type { DurableObjectStorage } from '@cloudflare/workers-types';
import type { TinybirdRecoveryStore } from '@trace-flow/tinybird-client';
import { stableHash } from './facts';
import { FactRepairProof, type StoredFactRepair } from './fact-repair-proof';
import {
  selectLatestFrozenFact,
  inspectLatestFrozenFact,
  validateFrozenFactIdentities,
  type FrozenFactIdentity,
  validateFrozenFactSelectors,
  type FrozenFactSelector,
  type FrozenFactSource,
  type FrozenFactSourceMetadata,
} from './frozen-fact-recovery';

const PENDING_TABLES = ['pending_facts', 'legacy_pending_facts'] as const;
const MAX_FROZEN_READ_BYTES = 900_000;

interface StoredLedgerFact {
  [key: string]: string;
  content_hash: string;
  data: string;
}

interface StoredPendingFact {
  [key: string]: string | number | null;
  id: number;
  content_hash: string | null;
  data: string;
}

export class FrozenFactSourceReader {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly recovery: TinybirdRecoveryStore,
  ) {}

  read(orgId: string, input: { facts: FrozenFactSelector[] }): FrozenFactSource[] {
    const selectors = validateFrozenFactSelectors(input?.facts);
    const sources: FrozenFactSource[] = [];
    let bytes = 2;
    for (const selector of selectors) {
      const ledger = this.ledger(selector);
      if (!ledger) throw new Error('frozen fact is not in the ledger');
      const source = selectLatestFrozenFact(
        orgId,
        selector,
        this.candidates(orgId, selector, ledger),
      );
      bytes += new TextEncoder().encode(JSON.stringify(source)).byteLength + 1;
      if (bytes > MAX_FROZEN_READ_BYTES) throw new Error('frozen fact read exceeds byte limit');
      sources.push(source);
    }
    return sources;
  }

  inspect(orgId: string, input: { facts: FrozenFactIdentity[] }): FrozenFactSourceMetadata[] {
    const metadata: FrozenFactSourceMetadata[] = [];
    for (const identity of validateFrozenFactIdentities(input?.facts)) {
      const ledger = this.ledger(identity);
      if (!ledger) continue;
      metadata.push(
        inspectLatestFrozenFact(orgId, identity, this.candidates(orgId, identity, ledger)),
      );
    }
    return metadata;
  }

  private *candidates(
    orgId: string,
    selector: FrozenFactIdentity,
    ledger: StoredLedgerFact,
  ): Iterable<Record<string, unknown>> {
    const ledgerPayload = this.loadPayload(
      'fact_ledger_payload_chunks',
      'category = ? AND fact_id = ?',
      [selector.category, selector.factId],
      ledger.data,
    );
    if (ledgerPayload) {
      const row = parseRow(ledgerPayload);
      if (stableHash(row) !== ledger.content_hash) {
        throw new Error('frozen ledger payload hash does not match');
      }
      yield row;
    }
    yield* this.pendingCandidates(selector);
    const proof = new FactRepairProof(this.recovery);
    for (const repair of this.storage.sql.exec<StoredFactRepair>(
      `SELECT id, category, fact_id, old_hash, new_hash, seen_at_ms, data, recovery_dedupe_key
       FROM fact_repairs WHERE category = ? AND fact_id = ? ORDER BY id`,
      selector.category,
      selector.factId,
    )) {
      const hydrated = this.hydrateRepair(repair);
      const verified = proof.verifySync(hydrated, orgId);
      if (!verified.verified || verified.value.recovery.state !== 'blocked') continue;
      yield parseRow(verified.value.recovery.payload);
    }
  }

  private ledger(selector: FrozenFactIdentity): StoredLedgerFact | undefined {
    return [
      ...this.storage.sql.exec<StoredLedgerFact>(
        `SELECT content_hash, COALESCE(data, '') AS data FROM fact_ledger
         WHERE category = ? AND fact_id = ?`,
        selector.category,
        selector.factId,
      ),
    ][0];
  }

  private *pendingCandidates(selector: FrozenFactIdentity): Iterable<Record<string, unknown>> {
    for (const table of PENDING_TABLES) {
      for (const pending of this.storage.sql.exec<StoredPendingFact>(
        `SELECT id, content_hash, data FROM ${table}
         WHERE category = ? AND fact_id = ? AND sent_at_ms IS NULL ORDER BY id`,
        selector.category,
        selector.factId,
      )) {
        const payload = this.loadPayload(
          'fact_payload_chunks',
          'table_name = ? AND row_id = ?',
          [table, pending.id],
          pending.data,
        );
        if (!payload) continue;
        const row = parseRow(payload);
        if (pending.content_hash && stableHash(row) !== pending.content_hash) {
          throw new Error('frozen pending payload hash does not match');
        }
        yield row;
      }
    }
  }

  private hydrateRepair(repair: StoredFactRepair): StoredFactRepair {
    if (repair.data !== null || !repair.recovery_dedupe_key) return repair;
    return {
      ...repair,
      data: this.recovery.repairByDedupeKey(repair.recovery_dedupe_key)?.payload ?? null,
    };
  }

  private loadPayload(
    chunkTable: 'fact_ledger_payload_chunks' | 'fact_payload_chunks',
    where: string,
    params: (string | number)[],
    fallback: string,
  ): string | null {
    if (fallback) return fallback;
    const chunks = [
      ...this.storage.sql.exec<{ data: string }>(
        `SELECT data FROM ${chunkTable} WHERE ${where} ORDER BY chunk_index`,
        ...params,
      ),
    ];
    return chunks.length > 0 ? chunks.map((chunk) => chunk.data).join('') : null;
  }
}

function parseRow(payload: string): Record<string, unknown> {
  const value: unknown = JSON.parse(payload);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('frozen fact payload is invalid');
  }
  return value as Record<string, unknown>;
}
