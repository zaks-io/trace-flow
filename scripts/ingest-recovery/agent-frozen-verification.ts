import { createHash } from 'node:crypto';
import {
  factIngestedAtMs,
  factPartitionKey,
  stableHash,
} from '../../apps/agent-consumer/src/facts';
import { CATEGORIES, type Category, type Row } from './agent-data';
import type { CanonicalHashIndex } from './agent-canonical-index';
import type { FrozenSourceMetadata } from './agent-frozen-journal';
import { normalized, type AgentRecoveryClient } from './agent-transport';

export interface FrozenVerificationCounts {
  total: number;
  exactMatches: number;
  safelySuperseded: number;
  expired: number;
  missing: number;
  conflicts: number;
}

export interface FrozenVerificationReport extends FrozenVerificationCounts {
  eligibleForLegacyRetirement: boolean;
  byCategory: Record<Category, FrozenVerificationCounts>;
}

interface FrozenSource {
  category: Category;
  factId: string;
  sourceHash: string;
  payload: string;
}

export async function verifyAllFrozenFacts(
  recovery: AgentRecoveryClient,
  index: CanonicalHashIndex,
): Promise<FrozenVerificationReport> {
  if (!index.complete) throw new Error('Canonical hash index export is incomplete');
  const report = emptyReport();
  let after: { category: Category; factId: string } | undefined;
  for (let pageNumber = 0; pageNumber < 100_000; pageNumber++) {
    const page = await recovery.call('listFrozenFacts', { after, limit: 100 });
    if (!Array.isArray(page?.facts) || page.facts.length > 100) {
      throw new Error('Invalid frozen fact page');
    }
    const identities = page.facts.map(validatePageIdentity);
    if (identities.length > 0) await verifyFrozenPage(recovery, index, identities, report);
    if (page.nextAfter === null) {
      report.eligibleForLegacyRetirement = report.missing === 0 && report.conflicts === 0;
      return report;
    }
    after = validatePageIdentity(page.nextAfter);
  }
  throw new Error('Frozen fact verification page bound exceeded');
}

async function verifyFrozenPage(
  recovery: AgentRecoveryClient,
  index: CanonicalHashIndex,
  identities: Array<{ category: Category; factId: string }>,
  report: FrozenVerificationReport,
): Promise<void> {
  const inspected = (await recovery.call('inspectFrozenFactSources', {
    facts: identities,
  })) as FrozenSourceMetadata[];
  assertExactIdentities(identities, inspected);
  for (const source of inspected) validateMetadata(source);
  const retained = inspected.filter((source) => {
    if (source.eventDay >= index.oldestDay) return true;
    increment(report, source.category, 'expired');
    return false;
  });
  for (const sources of sourceBatches(retained)) {
    const present = sources.filter((source) => {
      if (index.get(source.category, source.factId)) return true;
      increment(report, source.category, 'missing');
      return false;
    });
    if (present.length === 0) continue;
    const frozen = (await recovery.call('readFrozenFactSources', {
      facts: present.map(({ category, factId, sourceHash }) => ({
        category,
        factId,
        expectedSourceHash: sourceHash,
      })),
    })) as FrozenSource[];
    assertExactIdentities(present, frozen);
    for (const source of frozen) verifySource(index, source, present, report);
  }
}

function verifySource(
  index: CanonicalHashIndex,
  source: FrozenSource,
  metadataRows: FrozenSourceMetadata[],
  report: FrozenVerificationReport,
): void {
  const metadata = metadataRows.find((row) => factKey(row) === factKey(source));
  const current = index.get(source.category, source.factId);
  const schema = index.sourceSchema(source.category);
  try {
    const sourceRow = JSON.parse(source.payload) as Row;
    if (
      !metadata ||
      !current ||
      !schema ||
      source.sourceHash !== metadata.sourceHash ||
      stableHash(sourceRow) !== metadata.sourceHash ||
      factPartitionKey(source.category, sourceRow) !== metadata.eventDay ||
      String(sourceRow.IngestedAt) !== metadata.ingestedAt
    ) {
      increment(report, source.category, 'conflicts');
      return;
    }
    const sourceSha256 = createHash('sha256')
      .update(JSON.stringify(normalized(sourceRow, schema.meta)))
      .digest('hex');
    if (sourceSha256 === current.rowSha256) {
      increment(report, source.category, 'exactMatches');
    } else if (current.ingestedAtMs > factIngestedAtMs(sourceRow)) {
      increment(report, source.category, 'safelySuperseded');
    } else {
      increment(report, source.category, 'conflicts');
    }
  } catch {
    increment(report, source.category, 'conflicts');
  }
}

function validateMetadata(value: FrozenSourceMetadata): void {
  if (
    !/^[a-f0-9]{16}$/.test(value.sourceHash) ||
    !Number.isSafeInteger(value.payloadBytes) ||
    value.payloadBytes < 2 ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value.eventDay) ||
    !Number.isFinite(Date.parse(value.ingestedAt.replace(' ', 'T') + 'Z'))
  ) {
    throw new Error('Invalid frozen source metadata');
  }
}

function* sourceBatches(sources: FrozenSourceMetadata[]): Generator<FrozenSourceMetadata[]> {
  let batch: FrozenSourceMetadata[] = [];
  let bytes = 0;
  for (const source of sources) {
    const nextBytes = source.payloadBytes + Buffer.byteLength(source.factId) + 256;
    if (batch.length > 0 && (batch.length >= 100 || bytes + nextBytes > 850_000)) {
      yield batch;
      batch = [];
      bytes = 0;
    }
    batch.push(source);
    bytes += nextBytes;
  }
  if (batch.length > 0) yield batch;
}

function assertExactIdentities(
  requested: Array<{ category: Category; factId: string }>,
  returned: Array<{ category: Category; factId: string }>,
): void {
  const expected = requested.map(factKey).sort();
  const actual = returned.map(factKey).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error('Frozen source read does not match the requested identities');
  }
}

function validatePageIdentity(value: unknown): { category: Category; factId: string } {
  if (!value || typeof value !== 'object') throw new Error('Invalid frozen fact page identity');
  const row = value as Record<string, unknown>;
  if (
    !(CATEGORIES as readonly unknown[]).includes(row.category) ||
    typeof row.factId !== 'string' ||
    !row.factId
  ) {
    throw new Error('Invalid frozen fact page identity');
  }
  return { category: row.category as Category, factId: row.factId };
}

function emptyCounts(): FrozenVerificationCounts {
  return { total: 0, exactMatches: 0, safelySuperseded: 0, expired: 0, missing: 0, conflicts: 0 };
}

function emptyReport(): FrozenVerificationReport {
  return {
    ...emptyCounts(),
    eligibleForLegacyRetirement: false,
    byCategory: Object.fromEntries(
      CATEGORIES.map((category) => [category, emptyCounts()]),
    ) as Record<Category, FrozenVerificationCounts>,
  };
}

function increment(
  report: FrozenVerificationReport,
  category: Category,
  field: Exclude<keyof FrozenVerificationCounts, 'total'>,
): void {
  report[field]++;
  report.total++;
  report.byCategory[category][field]++;
  report.byCategory[category].total++;
}

function factKey(value: { category: Category; factId: string }): string {
  return `${value.category}\u0000${value.factId}`;
}
