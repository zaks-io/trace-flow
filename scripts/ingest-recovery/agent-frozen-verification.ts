import { createHash } from 'node:crypto';
import {
  factIngestedAtMs,
  factPartitionKey,
  stableHash,
} from '../../apps/agent-consumer/src/facts';
import { CATEGORIES, type Category, type Row } from './agent-data';
import type { CanonicalHashIndex, CanonicalHashRow } from './agent-canonical-index';
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
  verificationSha256: string;
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
  const digest = createHash('sha256');
  let page = await recovery.call('listFrozenFacts', { limit: 100 });
  for (let pageNumber = 0; pageNumber < 100_000; pageNumber++) {
    if (!Array.isArray(page?.facts) || page.facts.length > 100) {
      throw new Error('Invalid frozen fact page');
    }
    const identities = page.facts.map(validatePageIdentity);
    if (page.nextAfter === null) {
      if (identities.length > 0)
        await verifyFrozenPage(recovery, index, identities, report, digest);
      report.eligibleForLegacyRetirement = report.missing === 0 && report.conflicts === 0;
      report.verificationSha256 = digest.digest('hex');
      return report;
    }
    const after = validatePageIdentity(page.nextAfter);
    // Drain both reads on failure before the caller closes the canonical index.
    const [verified, next] = await Promise.allSettled([
      identities.length > 0
        ? verifyFrozenPage(recovery, index, identities, report, digest)
        : Promise.resolve(),
      recovery.call('listFrozenFacts', { after, limit: 100 }),
    ]);
    if (verified.status === 'rejected') throw verified.reason;
    if (next.status === 'rejected') throw next.reason;
    page = next.value;
  }
  throw new Error('Frozen fact verification page bound exceeded');
}

async function verifyFrozenPage(
  recovery: AgentRecoveryClient,
  index: CanonicalHashIndex,
  identities: Array<{ category: Category; factId: string }>,
  report: FrozenVerificationReport,
  digest: ReturnType<typeof createHash>,
): Promise<void> {
  const inspected = (await recovery.call('inspectFrozenFactSources', {
    facts: identities,
  })) as FrozenSourceMetadata[];
  assertExactIdentities(identities, inspected);
  for (const source of inspected) validateMetadata(source);
  const retained = inspected.filter((source) => {
    if (source.eventDay >= index.oldestDay) return true;
    record(report, digest, source, 'expired', null);
    return false;
  });
  for (const sources of sourceBatches(retained)) {
    const present = sources.filter((source) => {
      if (index.get(source.category, source.factId)) return true;
      record(report, digest, source, 'missing', null);
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
    frozen.sort((left, right) => factKey(left).localeCompare(factKey(right)));
    for (const source of frozen) verifySource(index, source, present, report, digest);
  }
}

function verifySource(
  index: CanonicalHashIndex,
  source: FrozenSource,
  metadataRows: FrozenSourceMetadata[],
  report: FrozenVerificationReport,
  digest: ReturnType<typeof createHash>,
): void {
  const metadata = metadataRows.find((row) => factKey(row) === factKey(source));
  const current = index.get(source.category, source.factId);
  const schema = index.sourceSchema(source.category);
  if (!metadata) throw new Error('Frozen source metadata is missing');
  try {
    const sourceRow = JSON.parse(source.payload) as Row;
    if (
      !current ||
      !schema ||
      source.sourceHash !== metadata.sourceHash ||
      stableHash(sourceRow) !== metadata.sourceHash ||
      factPartitionKey(source.category, sourceRow) !== metadata.eventDay ||
      String(sourceRow.IngestedAt) !== metadata.ingestedAt
    ) {
      record(report, digest, metadata, 'conflicts', current);
      return;
    }
    const sourceSha256 = createHash('sha256')
      .update(JSON.stringify(normalized(sourceRow, schema.meta)))
      .digest('hex');
    if (sourceSha256 === current.rowSha256) {
      record(report, digest, metadata, 'exactMatches', current);
    } else if (current.ingestedAtMs > factIngestedAtMs(sourceRow)) {
      record(report, digest, metadata, 'safelySuperseded', current);
    } else {
      record(report, digest, metadata, 'conflicts', current);
    }
  } catch {
    record(report, digest, metadata, 'conflicts', current);
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
    verificationSha256: '',
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

function record(
  report: FrozenVerificationReport,
  digest: ReturnType<typeof createHash>,
  source: FrozenSourceMetadata,
  classification: Exclude<keyof FrozenVerificationCounts, 'total'>,
  current: CanonicalHashRow | null,
): void {
  digest.update(
    `${JSON.stringify({
      source,
      classification,
      canonical: current,
    })}\n`,
  );
  increment(report, source.category, classification);
}

function factKey(value: { category: Category; factId: string }): string {
  return `${value.category}\u0000${value.factId}`;
}
