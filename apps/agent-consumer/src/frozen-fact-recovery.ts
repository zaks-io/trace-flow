import { fetchPipe } from '@trace-flow/tinybird-client';
import type { AgentDeliveryStagedReference } from '@trace-flow/types';
import { agentAnalyticsDayBounds, MAX_AGENT_DELIVERY_AGE_MS } from '@trace-flow/utils';
import {
  CATEGORIES,
  ROW_IDENTITY_FIELDS,
  compareFactIngestedAt,
  emptyAccumulator,
  factIngestedAtMs,
  factIdentityListParam,
  factPartitionKey,
  rowIdentity,
  stableHash,
  type Category,
} from './facts';
import type { DeliveryRows } from './delivery-rows';

const CONTENT_HASH = /^[0-9a-f]{64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

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

interface CanonicalIdentity {
  FactIdentity: string;
  EventDay: string;
  DeliverySequence: number;
  ContentHash: string;
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
  const { oldestDay, today } = agentAnalyticsDayBounds(Date.now());
  const liveRows = liveRowsByFact(delivery);
  if (proof.length !== liveRows.size)
    throw new Error('canonical proof does not cover the delivery');
  for (const category of CATEGORIES) {
    const categoryProof = proof.filter((item) => item.category === category);
    for (let offset = 0; offset < categoryProof.length; offset += 32) {
      const chunk = categoryProof.slice(offset, offset + 32);
      const identities = chunk.map((item) => item.factId);
      const current = await readCanonical(
        env,
        delivery.orgId,
        category,
        identities,
        oldestDay,
        today,
      );
      const byIdentity = new Map(current.map((row) => [row.FactIdentity, row]));
      for (const item of chunk) {
        const own = liveRows.get(factKey(category, item.factId));
        if (!own) throw new Error('canonical proof contains an unexpected identity');
        const actual = byIdentity.get(item.factId) ?? null;
        if (!matchesCanonical(actual, item.expected) && !matchesCanonical(actual, own)) {
          throw new Error(
            `canonical fact changed before frozen replay: ${category}:${item.factId}`,
          );
        }
      }
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

async function readCanonical(
  env: CanonicalReadEnv,
  orgId: string,
  category: Category,
  identities: string[],
  oldestDay: string,
  today: string,
): Promise<CanonicalIdentity[]> {
  const rows = await fetchPipe<CanonicalIdentity>({
    baseUrl: env.TINYBIRD_HOST,
    token: env.TINYBIRD_AGENT_DELIVERY_READ_TOKEN,
    pipe: 'agent_fact_identity_day',
    params: {
      org_id: orgId,
      category,
      identities: factIdentityListParam(identities),
      oldest_day: oldestDay,
      today_day: today,
    },
    schema: { parse: parseCanonicalIdentity },
  });
  const seen = new Set<string>();
  for (const row of rows) {
    if (!identities.includes(row.FactIdentity) || seen.has(row.FactIdentity)) {
      throw new Error('unexpected or duplicate canonical fact identity');
    }
    seen.add(row.FactIdentity);
  }
  return rows;
}

function parseCanonicalIdentity(value: unknown): CanonicalIdentity {
  assertRecord(value, 'canonical fact identity');
  if (
    typeof value.FactIdentity !== 'string' ||
    typeof value.EventDay !== 'string' ||
    !DAY.test(value.EventDay) ||
    !Number.isSafeInteger(Number(value.DeliverySequence)) ||
    Number(value.DeliverySequence) < 1 ||
    typeof value.ContentHash !== 'string' ||
    !CONTENT_HASH.test(value.ContentHash)
  ) {
    throw new Error('invalid canonical fact identity response');
  }
  return { ...value, DeliverySequence: Number(value.DeliverySequence) } as CanonicalIdentity;
}

function matchesCanonical(
  actual: CanonicalIdentity | null,
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
