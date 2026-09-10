import {
  AgentSnapshot,
  CATEGORIES,
  DATASOURCES,
  LEGACY_DATASOURCES,
  ROW_IDENTITY_FIELDS,
  digest,
  stableHash,
  type Category,
} from './agent-data';
import { AgentRecoveryClient, AgentTinybirdClient } from './agent-transport';

export async function captureSnapshot(
  snapshot: AgentSnapshot,
  tinybird: AgentTinybirdClient,
  recovery: AgentRecoveryClient,
  operationId: string,
  graph: { facts: string[]; derived: string[]; definitionHashInput: string },
): Promise<void> {
  snapshot.db.exec('BEGIN IMMEDIATE');
  try {
    snapshot.meta('complete', false);
    await populateSnapshot(snapshot, tinybird, recovery, operationId, graph);
  } finally {
    // Commit partial evidence on capture failure too; no cloud deletion starts until complete=true.
    snapshot.db.exec('COMMIT');
  }
}

async function populateSnapshot(
  snapshot: AgentSnapshot,
  tinybird: AgentTinybirdClient,
  recovery: AgentRecoveryClient,
  operationId: string,
  graph: { facts: string[]; derived: string[]; definitionHashInput: string },
): Promise<void> {
  snapshot.meta('org', recovery.org);
  snapshot.meta('host', tinybird.host);
  snapshot.meta('tinybirdWorkspaceId', recovery.matchedWorkspaceId ?? null);
  snapshot.meta('operationId', operationId);
  snapshot.meta('graph', graph);
  for (const category of CATEGORIES) {
    const canonical = DATASOURCES[category];
    if (!graph.facts.includes(canonical)) throw new Error(`Missing canonical table ${canonical}`);
    const legacy = LEGACY_DATASOURCES[category as keyof typeof LEGACY_DATASOURCES];
    if (legacy && graph.facts.includes(legacy)) {
      for await (const row of tinybird.rows(legacy, recovery.org, ROW_IDENTITY_FIELDS[category])) {
        snapshot.preserve(category, legacy, row, recovery.org);
      }
    }
    for await (const row of tinybird.rows(canonical, recovery.org, ROW_IDENTITY_FIELDS[category])) {
      snapshot.preserve(category, canonical, row, recovery.org);
    }
  }
  const replacements = new Map<
    number,
    { category: string; factId: string; oldHash: string; newHash: string }
  >();
  let after: unknown;
  do {
    const page = await recovery.call('listRebuildFacts', { operationId, after, limit: 100 });
    for (const fact of page.facts) {
      const payload = fact.payload ?? fact.replacement?.payload;
      const payloadHash = fact.payload === null ? fact.replacement?.contentHash : fact.contentHash;
      if (typeof payload !== 'string' || typeof payloadHash !== 'string')
        throw new Error(
          'Missing ledger payload and repair replacement; replay the collector before rebuilding',
        );
      if (stableHash(JSON.parse(payload)) !== payloadHash)
        throw new Error('Ledger or repair replacement payload hash mismatch');
      if (fact.payload === null) {
        const recoveryId = fact.replacement?.recoveryId;
        if (!Number.isSafeInteger(recoveryId) || recoveryId <= 0 || replacements.has(recoveryId))
          throw new Error('Invalid repair replacement receipt');
        replacements.set(recoveryId, {
          category: fact.category,
          factId: fact.factId,
          oldHash: fact.contentHash,
          newHash: payloadHash,
        });
      }
      snapshot.overlay(fact.category, fact.factId, payload, fact.contentHash, recovery.org);
      if (fact.pending.some((row: any) => row.table === 'legacy')) {
        const legacy = LEGACY_DATASOURCES[fact.category as keyof typeof LEGACY_DATASOURCES];
        if (!legacy || !graph.facts.includes(legacy))
          throw new Error('Pending legacy target is missing');
        snapshot.target(fact.category, fact.factId, legacy);
      }
    }
    after = page.nextAfter;
  } while (after);
  let afterId: number | undefined;
  do {
    const page = await recovery.call('listRecovery', { afterId, state: 'blocked', limit: 100 });
    for (const record of page.records) {
      snapshot.db
        .query('INSERT INTO recovery VALUES (?, ?)')
        .run(record.id, JSON.stringify(record));
      if (record.kind !== 'repair') continue;
      const outcome = JSON.parse(record.outcome);
      if (!CATEGORIES.includes(outcome.category)) throw new Error('Repair category mismatch');
      const prior = snapshot.get(outcome.category, outcome.factId);
      if (!prior?.old_hash) throw new Error('Repair identity absent from ledger');
      if (outcome.oldHash !== prior.old_hash)
        throw new Error('Repair base does not match the ledger');
      if (stableHash(JSON.parse(record.payload)) !== outcome.newHash)
        throw new Error('Repair payload hash mismatch');
      const replacement = replacements.get(record.id);
      if (replacement) {
        if (
          replacement.category !== outcome.category ||
          replacement.factId !== outcome.factId ||
          replacement.oldHash !== outcome.oldHash ||
          replacement.newHash !== outcome.newHash
        )
          throw new Error('Repair replacement receipt does not match the ledger candidate');
        replacements.delete(record.id);
      }
      // Recovery IDs are durable arrival order. Superseded versions remain in the backup.
      snapshot.overlay(
        outcome.category,
        outcome.factId,
        record.payload,
        prior.old_hash,
        recovery.org,
      );
    }
    afterId = page.nextAfterId;
  } while (afterId);
  if (replacements.size)
    throw new Error('Repair replacement receipt is absent from the recovery snapshot');
  snapshot.meta('fingerprint', snapshot.fingerprint());
  snapshot.meta('complete', true);
}

export function* confirmations(snapshot: AgentSnapshot, category: Category) {
  for (const record of snapshot.rows(category)) {
    if (record.ledger === null) continue;
    yield {
      category,
      factId: record.fact_id,
      expectedOldHash: record.old_hash!,
      newHash: stableHash(JSON.parse(record.ledger)),
      row: JSON.parse(record.ledger),
    };
  }
}

export function* recoveryConfirmations(
  snapshot: AgentSnapshot,
  kind: 'repair' | 'tinybird_insert',
) {
  for (const { data } of snapshot.db
    .query<{ data: string }, []>('SELECT data FROM recovery ORDER BY id')
    .iterate()) {
    const record = JSON.parse(data);
    if (record.kind === kind)
      yield { recoveryId: record.id, expectedPayloadHash: stableHash(JSON.parse(record.payload)) };
  }
}

export function graphFingerprint(graph: {
  facts?: string[];
  derived?: string[];
  definitionHashInput: string;
}): string {
  return digest(
    JSON.stringify([
      graph.facts?.slice().sort(),
      graph.derived?.slice().sort(),
      graph.definitionHashInput,
    ]),
  );
}
