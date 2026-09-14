import { MAX_AGENT_DELIVERY_AGE_MS, MAX_AGENT_DELIVERY_CLOCK_SKEW_MS } from '@trace-flow/utils';
import { CATEGORIES, type Category } from './facts';

const MAX_FROZEN_FACTS = 100;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOURCE_HASH = /^[0-9a-f]{16}$/;
const CONTENT_HASH = /^[0-9a-f]{64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface FrozenFactSelector {
  category: Category;
  factId: string;
  expectedSourceHash: string;
}

export interface FrozenFactIdentity {
  category: Category;
  factId: string;
}

export interface FrozenFactIdentityPage {
  facts: FrozenFactIdentity[];
  nextAfter: FrozenFactIdentity | null;
}

export interface ExpectedCanonicalFact {
  category: Category;
  factId: string;
  expected: {
    eventDay: string;
    deliverySequence: number;
    contentHash: string;
  } | null;
}

export interface ReplayFrozenFactsInput {
  deliveryId: string;
  createdAtMs: number;
  facts: (FrozenFactSelector & { expectedCanonical: ExpectedCanonicalFact['expected'] })[];
}

export function validateReplayFrozenFactsInput(input: unknown): ReplayFrozenFactsInput {
  assertRecord(input, 'frozen replay input');
  assertExactKeys(input, ['createdAtMs', 'deliveryId', 'facts'], 'frozen replay input');
  if (typeof input.deliveryId !== 'string' || !UUID_V4.test(input.deliveryId)) {
    throw new Error('invalid frozen replay delivery ID');
  }
  if (!Number.isSafeInteger(input.createdAtMs) || Number(input.createdAtMs) <= 0) {
    throw new Error('invalid frozen replay creation time');
  }
  const expiresAtMs = Number(input.createdAtMs) + MAX_AGENT_DELIVERY_AGE_MS;
  if (
    !Number.isSafeInteger(expiresAtMs) ||
    expiresAtMs <= Date.now() ||
    Number(input.createdAtMs) > Date.now() + MAX_AGENT_DELIVERY_CLOCK_SKEW_MS
  ) {
    throw new Error('frozen replay creation time is outside the delivery window');
  }
  if (
    !Array.isArray(input.facts) ||
    input.facts.length === 0 ||
    input.facts.length > MAX_FROZEN_FACTS
  ) {
    throw new Error(`frozen replay requires 1 to ${MAX_FROZEN_FACTS} facts`);
  }
  const facts = input.facts.map((value) => validateReplayFact(value));
  assertUniqueFacts(facts);
  return {
    deliveryId: input.deliveryId.toLowerCase(),
    createdAtMs: Number(input.createdAtMs),
    facts,
  };
}

export function validateFrozenFactSelectors(input: unknown): FrozenFactSelector[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_FROZEN_FACTS) {
    throw new Error(`frozen fact reads require 1 to ${MAX_FROZEN_FACTS} facts`);
  }
  const selectors = input.map((value) => {
    assertRecord(value, 'frozen fact selector');
    assertExactKeys(value, ['category', 'expectedSourceHash', 'factId'], 'frozen fact selector');
    const category = validateCategory(value.category);
    if (
      typeof value.factId !== 'string' ||
      value.factId.length === 0 ||
      value.factId.length > 4096
    ) {
      throw new Error('invalid frozen fact ID');
    }
    if (
      typeof value.expectedSourceHash !== 'string' ||
      !SOURCE_HASH.test(value.expectedSourceHash)
    ) {
      throw new Error('invalid frozen fact source hash');
    }
    return { category, factId: value.factId, expectedSourceHash: value.expectedSourceHash };
  });
  assertUniqueFacts(selectors);
  return selectors;
}

export function validateFrozenFactIdentities(input: unknown): FrozenFactIdentity[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_FROZEN_FACTS) {
    throw new Error(`frozen fact inspection requires 1 to ${MAX_FROZEN_FACTS} facts`);
  }
  const facts = input.map((value) => {
    assertRecord(value, 'frozen fact identity');
    assertExactKeys(value, ['category', 'factId'], 'frozen fact identity');
    const category = validateCategory(value.category);
    if (
      typeof value.factId !== 'string' ||
      value.factId.length === 0 ||
      value.factId.length > 4096
    ) {
      throw new Error('invalid frozen fact ID');
    }
    return { category, factId: value.factId };
  });
  assertUniqueFacts(facts);
  return facts;
}

export function validateExpectedCanonicalProof(value: unknown): ExpectedCanonicalFact[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FROZEN_FACTS) {
    throw new Error(`canonical proof requires 1 to ${MAX_FROZEN_FACTS} facts`);
  }
  const proof = value.map((item) => {
    assertRecord(item, 'expected canonical fact');
    assertExactKeys(item, ['category', 'expected', 'factId'], 'expected canonical fact');
    const category = validateCategory(item.category);
    if (typeof item.factId !== 'string' || item.factId.length === 0 || item.factId.length > 4096) {
      throw new Error('invalid expected canonical fact ID');
    }
    return { category, factId: item.factId, expected: validateExpectedCanonical(item.expected) };
  });
  assertUniqueFacts(proof);
  return proof;
}

function validateReplayFact(value: unknown): ReplayFrozenFactsInput['facts'][number] {
  assertRecord(value, 'frozen replay fact');
  assertExactKeys(
    value,
    ['category', 'expectedCanonical', 'expectedSourceHash', 'factId'],
    'frozen replay fact',
  );
  const [selector] = validateFrozenFactSelectors([
    {
      category: value.category,
      factId: value.factId,
      expectedSourceHash: value.expectedSourceHash,
    },
  ]);
  return { ...selector!, expectedCanonical: validateExpectedCanonical(value.expectedCanonical) };
}

function validateExpectedCanonical(value: unknown): ExpectedCanonicalFact['expected'] {
  if (value === null) return null;
  assertRecord(value, 'expected canonical fact');
  assertExactKeys(
    value,
    ['contentHash', 'deliverySequence', 'eventDay'],
    'expected canonical fact',
  );
  if (typeof value.eventDay !== 'string' || !DAY.test(value.eventDay))
    throw new Error('invalid expected canonical day');
  if (!Number.isSafeInteger(value.deliverySequence) || Number(value.deliverySequence) < 1)
    throw new Error('invalid expected canonical revision');
  if (typeof value.contentHash !== 'string' || !CONTENT_HASH.test(value.contentHash))
    throw new Error('invalid expected canonical hash');
  return {
    eventDay: value.eventDay,
    deliverySequence: Number(value.deliverySequence),
    contentHash: value.contentHash,
  };
}

function validateCategory(value: unknown): Category {
  if (typeof value !== 'string' || !(CATEGORIES as readonly string[]).includes(value))
    throw new Error('invalid frozen fact category');
  return value as Category;
}

function assertUniqueFacts(values: { category: Category; factId: string }[]): void {
  const keys = new Set(values.map((value) => `${value.category}\u0000${value.factId}`));
  if (keys.size !== values.length) throw new Error('frozen facts contain duplicate identities');
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`invalid ${label}`);
}

function assertExactKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)))
    throw new Error(`invalid ${label}`);
}
