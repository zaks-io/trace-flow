import { fetchPipe } from '@trace-flow/tinybird-client';
import { agentAnalyticsDayBounds } from '@trace-flow/utils';
import { CATEGORIES, factIngestedAtMs, type Category } from './facts';

interface FactIdentityDayEnv {
  TINYBIRD_HOST: string;
  TINYBIRD_AGENT_DELIVERY_READ_TOKEN: string;
}

export interface FactIdentityDay {
  Category: Category;
  FactIdentity: string;
  EventDay: string;
  DeliverySequence: number;
  ContentHash: string;
  IngestedAt: string;
}

export type FactIdentityDays = Record<Category, Map<string, FactIdentityDay>>;

interface LookupBatch {
  categories: Category[];
  identities: string[];
}

// agent_fact_identity_day_batch returns at most one row per requested identity, up to its LIMIT.
const BATCH_IDENTITIES = 512;
// Tinybird renders both arrays into the query text and rejects queries over its maximum size.
const BATCH_BYTES = 64 * 1024;
// Workers allow six simultaneous outbound connections per invocation.
const BATCH_CONCURRENCY = 6;

const encoder = new TextEncoder();

/**
 * Reads the current retained day of every identity in one request when the bounds allow, so a
 * delivery holding its organization's write permit does not wait on one round trip per category.
 */
export async function lookupFactIdentityDays(
  env: FactIdentityDayEnv,
  orgId: string,
  identities: Partial<Record<Category, Iterable<string>>>,
): Promise<FactIdentityDays> {
  const { oldestDay, today } = agentAnalyticsDayBounds(Date.now());
  const batches = lookupBatches(identities);
  const found = Object.fromEntries(
    CATEGORIES.map((category) => [category, new Map<string, FactIdentityDay>()]),
  ) as FactIdentityDays;
  for (let offset = 0; offset < batches.length; offset += BATCH_CONCURRENCY) {
    const results = await Promise.all(
      batches
        .slice(offset, offset + BATCH_CONCURRENCY)
        .map((batch) => readBatch(env, orgId, batch, oldestDay, today)),
    );
    for (const entry of results.flat()) found[entry.Category].set(entry.FactIdentity, entry);
  }
  return found;
}

function lookupBatches(identities: Partial<Record<Category, Iterable<string>>>): LookupBatch[] {
  const batches: LookupBatch[] = [];
  let batch: LookupBatch = { categories: [], identities: [] };
  let bytes = 0;
  for (const category of CATEGORIES) {
    for (const identity of new Set(identities[category])) {
      if (identity.length === 0 || identity.includes(',')) {
        throw new Error('Invalid fact identity lookup');
      }
      const size = encoder.encode(identity).byteLength + category.length;
      if (
        batch.identities.length > 0 &&
        (batch.identities.length === BATCH_IDENTITIES || bytes + size > BATCH_BYTES)
      ) {
        batches.push(batch);
        batch = { categories: [], identities: [] };
        bytes = 0;
      }
      batch.categories.push(category);
      batch.identities.push(identity);
      bytes += size;
    }
  }
  if (batch.identities.length > 0) batches.push(batch);
  return batches;
}

async function readBatch(
  env: FactIdentityDayEnv,
  orgId: string,
  batch: LookupBatch,
  oldestDay: string,
  today: string,
): Promise<FactIdentityDay[]> {
  const entries = await fetchPipe<FactIdentityDay>({
    baseUrl: env.TINYBIRD_HOST,
    token: env.TINYBIRD_AGENT_DELIVERY_READ_TOKEN,
    pipe: 'agent_fact_identity_day_batch',
    method: 'POST',
    params: {
      org_id: orgId,
      categories: batch.categories.join(','),
      identities: batch.identities.join(','),
      oldest_day: oldestDay,
      today_day: today,
    },
    requireData: true,
    schema: { parse: parseFactIdentityDay },
  });
  const requested = new Set(
    batch.identities.map((identity, index) => factKey(batch.categories[index]!, identity)),
  );
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = factKey(entry.Category, entry.FactIdentity);
    if (!requested.has(key) || seen.has(key)) {
      throw new Error('Unexpected or duplicate identity day response');
    }
    seen.add(key);
  }
  return entries;
}

function parseFactIdentityDay(value: unknown): FactIdentityDay {
  const entry = value as FactIdentityDay;
  if (
    !entry ||
    !CATEGORIES.includes(entry.Category) ||
    typeof entry.FactIdentity !== 'string' ||
    typeof entry.EventDay !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(entry.EventDay) ||
    !Number.isSafeInteger(Number(entry.DeliverySequence)) ||
    Number(entry.DeliverySequence) < 1 ||
    typeof entry.ContentHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(entry.ContentHash) ||
    typeof entry.IngestedAt !== 'string'
  ) {
    throw new Error('Invalid fact identity day response');
  }
  factIngestedAtMs(entry);
  return { ...entry, DeliverySequence: Number(entry.DeliverySequence) };
}

function factKey(category: Category, identity: string): string {
  return `${category}\u0000${identity}`;
}
