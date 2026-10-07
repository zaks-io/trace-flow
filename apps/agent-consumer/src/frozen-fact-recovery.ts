import type { AgentDeliveryStagedReference } from '@trace-flow/types';
import { MAX_AGENT_DELIVERY_AGE_MS } from '@trace-flow/utils';
import {
  CATEGORIES,
  ROW_IDENTITY_FIELDS,
  compareFactIngestedAt,
  emptyAccumulator,
  factIngestedAtMs,
  factPartitionKey,
  rowIdentity,
  stableHash,
  type Category,
} from './facts';
import { lookupFactIdentityDays, type FactIdentityDay } from './fact-identity-days';
import type { DeliveryRows } from './delivery-rows';

const CONTENT_HASH = /^[0-9a-f]{64}$/;

export {
  validateExpectedCanonicalProof,
  validateFrozenFactIdentities,
  validateFrozenFactSelectors,
  validateReplayFrozenFactsInput,
} from './frozen-fact-contract';
export type {
  ExpectedCanonicalFact,
  FrozenFactIdentity,
  FrozenFactIdentityPage,
  FrozenFactSelector,
  ReplayFrozenFactsInput,
} from './frozen-fact-contract';
import {
  validateExpectedCanonicalProof,
  type ExpectedCanonicalFact,
  type FrozenFactIdentity,
  type FrozenFactSelector,
  type ReplayFrozenFactsInput,
} from './frozen-fact-contract';

export interface FrozenFactSource {
  category: Category;
  factId: string;
  sourceHash: string;
  payload: string;
}

export interface FrozenFactSourceMetadata extends FrozenFactIdentity {
  sourceHash: string;
  payloadBytes: number;
  eventDay: string;
  ingestedAt: string;
}

interface CanonicalReadEnv {
  TINYBIRD_HOST: string;
  TINYBIRD_AGENT_DELIVERY_READ_TOKEN: string;
}

export function selectLatestFrozenFact(
  orgId: string,
  selector: FrozenFactSelector,
  candidates: Iterable<unknown>,
): FrozenFactSource {
  const latest = latestFrozenFactRow(orgId, selector, candidates);
  const sourceHash = stableHash(latest);
  if (sourceHash !== selector.expectedSourceHash)
    throw new Error('frozen fact source hash changed');
  return {
    category: selector.category,
    factId: selector.factId,
    sourceHash,
    payload: JSON.stringify(latest),
  };
}

export function inspectLatestFrozenFact(
  orgId: string,
  identity: FrozenFactIdentity,
  candidates: Iterable<unknown>,
): FrozenFactSourceMetadata {
  const latest = latestFrozenFactRow(orgId, identity, candidates);
  return {
    ...identity,
    sourceHash: stableHash(latest),
    payloadBytes: new TextEncoder().encode(JSON.stringify(latest)).byteLength,
    eventDay: factPartitionKey(identity.category, latest),
    ingestedAt: latest.IngestedAt as string,
  };
}

function latestFrozenFactRow(
  orgId: string,
  identity: FrozenFactIdentity,
  candidates: Iterable<unknown>,
): Record<string, unknown> {
  let latest: Record<string, unknown> | undefined;
  for (const row of candidates) {
    const candidate = validateSourceRow(orgId, identity, row);
    if (!latest) {
      latest = candidate;
      continue;
    }
    const order = compareFactIngestedAt(candidate, latest);
    if (order > 0) latest = candidate;
    else if (order === 0 && stableHash(candidate) !== stableHash(latest)) {
      throw new Error('frozen fact has conflicting payloads at the latest ingestion time');
    }
  }
  if (!latest) throw new Error('frozen fact source payload is missing');
  return latest;
}

export function buildFrozenDelivery(
  orgId: string,
  createdAtMs: number,
  sources: FrozenFactSource[],
): DeliveryRows {
  const rows = emptyAccumulator();
  for (const source of sources) rows[source.category].push(JSON.parse(source.payload));
  return { orgId, revision: 1, expiresAt: createdAtMs + MAX_AGENT_DELIVERY_AGE_MS, rows };
}

export function frozenDeliveryReference(
  deliveryId: string,
  createdAtMs: number,
  orgId: string,
  sha256: string,
): AgentDeliveryStagedReference {
  return {
    type: 'agent-delivery',
    version: 1,
    key: `agent-deliveries/${orgId}/${deliveryId}`,
    org_id: orgId,
    sha256,
    created_at: createdAtMs,
    expires_at: createdAtMs + MAX_AGENT_DELIVERY_AGE_MS,
  };
}

export function frozenDeliveryDays(delivery: DeliveryRows): string[] {
  return [
    ...new Set(
      CATEGORIES.flatMap((category) =>
        delivery.rows[category].map((row) => factPartitionKey(category, row)),
      ),
    ),
  ].sort();
}

export function canonicalProof(input: ReplayFrozenFactsInput): ExpectedCanonicalFact[] {
  return input.facts.map(({ category, factId, expectedCanonical }) => ({
    category,
    factId,
    expected: expectedCanonical,
  }));
}

export async function assertExpectedCanonicalFacts(
  env: CanonicalReadEnv,
  delivery: DeliveryRows,
  proof: ExpectedCanonicalFact[],
): Promise<void> {
  proof = validateExpectedCanonicalProof(proof);
  const liveRows = liveRowsByFact(delivery);
  if (proof.length !== liveRows.size)
    throw new Error('canonical proof does not cover the delivery');
  const identities: Partial<Record<Category, string[]>> = {};
  for (const item of proof) {
    if (!liveRows.has(factKey(item.category, item.factId))) {
      throw new Error('canonical proof contains an unexpected identity');
    }
    (identities[item.category] ??= []).push(item.factId);
  }
  const current = await lookupFactIdentityDays(env, delivery.orgId, identities);
  for (const item of proof) {
    const own = liveRows.get(factKey(item.category, item.factId))!;
    const actual = current[item.category].get(item.factId) ?? null;
    if (!matchesCanonical(actual, item.expected) && !matchesCanonical(actual, own)) {
      throw new Error(
        `canonical fact changed before frozen replay: ${item.category}:${item.factId}`,
      );
    }
  }
}

function liveRowsByFact(delivery: DeliveryRows): Map<string, ExpectedCanonicalFact['expected']> {
  const result = new Map<string, NonNullable<ExpectedCanonicalFact['expected']>>();
  for (const category of CATEGORIES) {
    for (const value of delivery.rows[category]) {
      const row = value as Record<string, unknown>;
      if (row.IsDeleted !== 0) continue;
      const factId = rowIdentity(row, ROW_IDENTITY_FIELDS[category]);
      if (typeof row.ContentHash !== 'string' || !CONTENT_HASH.test(row.ContentHash)) {
        throw new Error('frozen delivery has invalid content hash');
      }
      result.set(factKey(category, factId), {
        eventDay: factPartitionKey(category, row),
        deliverySequence: delivery.revision,
        contentHash: row.ContentHash,
      });
    }
  }
  return result;
}

function matchesCanonical(
  actual: FactIdentityDay | null,
  expected: ExpectedCanonicalFact['expected'],
): boolean {
  if (!actual || !expected) return actual === null && expected === null;
  return (
    actual.EventDay === expected.eventDay &&
    actual.DeliverySequence === expected.deliverySequence &&
    actual.ContentHash === expected.contentHash
  );
}

function validateSourceRow(
  orgId: string,
  selector: FrozenFactIdentity,
  value: unknown,
): Record<string, unknown> {
  assertRecord(value, 'frozen fact payload');
  if (value.OrgId !== orgId) throw new Error('frozen fact organization does not match');
  const identityFields = ROW_IDENTITY_FIELDS[selector.category];
  if (identityFields.some((field) => typeof value[field] !== 'string' || value[field] === '')) {
    throw new Error('frozen fact has invalid natural identity');
  }
  if (rowIdentity(value, identityFields) !== selector.factId)
    throw new Error('frozen fact identity does not match');
  void factIngestedAtMs(value);
  void factPartitionKey(selector.category, value);
  return value;
}

function factKey(category: Category, factId: string): string {
  return `${category}\u0000${factId}`;
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`invalid ${label}`);
}
