import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { MAX_AGENT_DELIVERY_AGE_MS } from '../../packages/utils/src/agent-delivery';
import { agentAnalyticsDayBounds } from '../../packages/utils/src/agent-retention';
import { CATEGORIES, quote, type Category } from './agent-data';
import {
  FrozenRecoveryJournal,
  type FrozenBatch,
  type FrozenSourceMetadata,
} from './agent-frozen-journal';
import { MIGRATION_ID } from './agent-migration-proof';
import { verifyMigrationTarget } from './agent-migration-target';
import type { AgentRecoveryClient, AgentTinybirdClient } from './agent-transport';

const PAGE_SIZE = 100;
const UUID = /^[0-9a-f-]{36}$/i;

export interface CanonicalIdentity {
  category: Category;
  factId: string;
  eventDay: string;
  deliverySequence: number;
  contentHash: string;
}

interface CensusRow {
  category: Category;
  source: string;
  session_pk: string;
  pk: string;
}

export async function censusSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export function* missingCensusPages(path: string, orgId: string): Generator<CensusRow[]> {
  const db = new Database(path, { readonly: true, strict: true });
  try {
    assertCensusSchema(db);
    db.exec('BEGIN');
    let after: CensusRow | undefined;
    while (true) {
      const rows = db
        .query<CensusRow, [string, string, string, string, number]>(
          `SELECT m.category,m.source,m.session_pk,m.pk
           FROM initial_missing m
           WHERE (m.category,m.source,m.session_pk,m.pk) > (?,?,?,?)
             AND NOT EXISTS (
               SELECT 1 FROM current_found f
               WHERE f.category=m.category AND f.source=m.source
                 AND f.session_pk=m.session_pk AND f.pk=m.pk
             )
           ORDER BY m.category,m.source,m.session_pk,m.pk LIMIT ?`,
        )
        .all(
          after?.category ?? '',
          after?.source ?? '',
          after?.session_pk ?? '',
          after?.pk ?? '',
          PAGE_SIZE,
        );
      if (rows.length === 0) return;
      for (const row of rows) validateCensusRow(row, orgId);
      yield rows;
      after = rows.at(-1)!;
    }
  } finally {
    db.close();
  }
}

export async function inspectMissingCensus(
  path: string,
  orgId: string,
  recovery: AgentRecoveryClient,
  journal: FrozenRecoveryJournal,
  tb: AgentTinybirdClient,
): Promise<void> {
  const { oldestDay } = agentAnalyticsDayBounds(Date.now());
  for (const page of missingCensusPages(path, orgId)) {
    const facts = page.map((row) => ({
      category: row.category,
      factId: `${orgId}\x1f${row.session_pk}\x1f${row.pk}`,
    }));
    const found = (await recovery.call('inspectFrozenFactSources', { facts })) as unknown;
    if (!Array.isArray(found)) throw new Error('Invalid frozen source inspection response');
    journal.recordInspection(facts, found as FrozenSourceMetadata[], oldestDay);
    const retained = (found as FrozenSourceMetadata[]).filter(
      (source) => source.eventDay >= oldestDay,
    );
    const canonical = await readCanonicalIdentities(tb, orgId, retained);
    journal.markConflicts(canonical.map(({ category, factId }) => ({ category, factId })));
  }
}

export async function recoverReadyFacts(
  recovery: AgentRecoveryClient,
  journal: FrozenRecoveryJournal,
  tb: AgentTinybirdClient,
  orgId: string,
  now = () => Date.now(),
): Promise<void> {
  for (const pending of journal.pendingBatches())
    await replayBatch(recovery, journal, pending, now());
  while (true) {
    const candidates = journal.nextReadyCandidates();
    if (candidates.length === 0) return;
    const canonical = await readCanonicalIdentities(tb, orgId, candidates);
    if (canonical.length > 0) {
      journal.markConflicts(canonical.map(({ category, factId }) => ({ category, factId })));
      continue;
    }
    await replayBatch(recovery, journal, journal.createBatch(candidates, now()), now());
  }
}

export async function assertFrozenRecoveryTarget(
  recovery: AgentRecoveryClient,
  tb: AgentTinybirdClient,
): Promise<any> {
  const state = await recovery.call('inspectIngestionMigration', {});
  await verifyMigrationTarget(tb, state?.migrationTarget);
  if (state?.legacy?.migrationId !== MIGRATION_ID || state?.migration?.complete !== true) {
    throw new Error('Frozen recovery requires a completed bounded ingestion migration');
  }
  return state;
}

export async function readCanonicalIdentities(
  tb: AgentTinybirdClient,
  orgId: string,
  facts: Array<{ category: Category; factId: string }>,
): Promise<CanonicalIdentity[]> {
  const { oldestDay, today } = agentAnalyticsDayBounds(Date.now());
  const results: CanonicalIdentity[] = [];
  for (const category of CATEGORIES) {
    const identities = facts
      .filter((fact) => fact.category === category)
      .map((fact) => fact.factId);
    for (let offset = 0; offset < identities.length; offset += PAGE_SIZE) {
      const chunk = identities.slice(offset, offset + PAGE_SIZE);
      if (chunk.some((identity) => identity.includes(','))) {
        throw new Error('Frozen recovery fact identity contains a comma');
      }
      const rows = (
        await tb.sql(`SELECT FactIdentity,EventDay,DeliverySequence,ContentHash
          FROM agent_fact_identity_days FINAL
          WHERE OrgId=${quote(orgId)} AND Category=${quote(category)}
            AND FactIdentity IN (${chunk.map(quote).join(',')})
            AND EventDay>=toDate(${quote(oldestDay)}) AND EventDay<=toDate(${quote(today)})
          ORDER BY FactIdentity LIMIT ${chunk.length + 1}`)
      ).data;
      if (rows.length > chunk.length)
        throw new Error('Canonical identity response exceeds request');
      const seen = new Set<string>();
      for (const row of rows) {
        const factId = String(row.FactIdentity);
        const eventDay = String(row.EventDay);
        const deliverySequence = Number(row.DeliverySequence);
        const contentHash = String(row.ContentHash);
        if (
          !chunk.includes(factId) ||
          seen.has(factId) ||
          !/^\d{4}-\d{2}-\d{2}$/.test(eventDay) ||
          !Number.isSafeInteger(deliverySequence) ||
          deliverySequence < 1 ||
          !/^[a-f0-9]{64}$/.test(contentHash)
        ) {
          throw new Error('Invalid canonical identity response');
        }
        seen.add(factId);
        results.push({ category, factId, eventDay, deliverySequence, contentHash });
      }
    }
  }
  return results;
}

async function replayBatch(
  recovery: AgentRecoveryClient,
  journal: FrozenRecoveryJournal,
  batch: FrozenBatch,
  currentTime: number,
): Promise<void> {
  if (batch.createdAtMs + MAX_AGENT_DELIVERY_AGE_MS <= currentTime) {
    throw new Error('Frozen recovery journal contains an expired pending delivery');
  }
  const result = await recovery.call('replayFrozenFacts', {
    deliveryId: batch.deliveryId,
    createdAtMs: batch.createdAtMs,
    facts: batch.facts.map((fact) => ({ ...fact, expectedCanonical: null })),
  });
  if (
    result?.status !== 'confirmed' ||
    result.deliveryId !== batch.deliveryId ||
    result.factCount !== batch.facts.length ||
    !Number.isSafeInteger(result.deliverySequence) ||
    result.deliverySequence < 2
  ) {
    throw new Error('Frozen recovery confirmation is invalid');
  }
  journal.confirm(batch.deliveryId);
}

function assertCensusSchema(db: Database): void {
  for (const [table, expected] of [
    ['initial_missing', ['category', 'source', 'session_pk', 'pk']],
    ['current_found', ['category', 'source', 'session_pk', 'pk', 'store']],
  ] as const) {
    const columns = db
      .query<{ name: string }, []>(`SELECT name FROM pragma_table_info('${table}') ORDER BY cid`)
      .all()
      .map(({ name }) => name);
    if (JSON.stringify(columns) !== JSON.stringify(expected)) {
      throw new Error('Unsupported local identity census schema');
    }
  }
}

function validateCensusRow(row: CensusRow, orgId: string): void {
  if (
    !(CATEGORIES as readonly string[]).includes(row.category) ||
    !['claude', 'codex', 'cursor'].includes(row.source) ||
    !UUID.test(row.session_pk) ||
    !UUID.test(row.pk) ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(orgId)
  ) {
    throw new Error('Invalid local identity census row');
  }
}
