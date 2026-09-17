import { fetchPipe } from '@trace-flow/tinybird-client';
import { agentAnalyticsDayBounds, sha256Hex } from '@trace-flow/utils';
import {
  CATEGORIES,
  ROW_IDENTITY_FIELDS,
  factIngestedAtMs,
  factIdentityListParam,
  factPartitionKey,
  rowIdentity,
} from './facts';
import type { DeliveryRows } from './delivery-rows';

interface PartitionLookupEnv {
  TINYBIRD_HOST: string;
  TINYBIRD_AGENT_DELIVERY_READ_TOKEN: string;
}

// agent_fact_identity_day is a GET endpoint capped at 32 identities per call.
const IDENTITY_LOOKUP_SIZE = 32;
// Workers allow six simultaneous outbound connections per invocation.
const IDENTITY_LOOKUP_CONCURRENCY = 6;

interface IdentityDay {
  FactIdentity: string;
  EventDay: string;
  DeliverySequence: number;
  ContentHash: string;
  IngestedAt: string;
}

/** The caller holds the organization's write permit until this exact plan is committed. */
export async function prepareDeliveryPartitions(
  env: PartitionLookupEnv,
  delivery: DeliveryRows,
  options: { legacySourceOrder?: boolean } = {},
): Promise<string[]> {
  const { oldestDay, today } = agentAnalyticsDayBounds(Date.now());
  const dirtyDays = new Set<string>();
  for (const category of CATEGORIES) {
    const rows = delivery.rows[category] as Record<string, unknown>[];
    const retained: Record<string, unknown>[] = [];
    const tombstones: Record<string, unknown>[] = [];
    const byIdentity = new Map<string, IdentityDay>();
    const chunks: string[][] = [];
    for (let offset = 0; offset < rows.length; offset += IDENTITY_LOOKUP_SIZE) {
      chunks.push(
        rows
          .slice(offset, offset + IDENTITY_LOOKUP_SIZE)
          .map((row) => rowIdentity(row, ROW_IDENTITY_FIELDS[category])),
      );
    }
    // The organization's write permit is held here, so serial lookups stall its other deliveries.
    for (let wave = 0; wave < chunks.length; wave += IDENTITY_LOOKUP_CONCURRENCY) {
      const lookups = await Promise.all(
        chunks
          .slice(wave, wave + IDENTITY_LOOKUP_CONCURRENCY)
          .map((identities) =>
            lookupIdentityDays(env, delivery, category, identities, oldestDay, today),
          ),
      );
      for (const entry of lookups.flat()) byIdentity.set(entry.FactIdentity, entry);
    }
    for (const row of rows) {
      const day = factPartitionKey(category, row);
      const previous = byIdentity.get(rowIdentity(row, ROW_IDENTITY_FIELDS[category]));
      if (previous && options.legacySourceOrder) {
        const order = factIngestedAtMs(row) - factIngestedAtMs(previous);
        if (order < 0) continue;
        if (order === 0) {
          if (
            (await contentHashAtRevision(row, previous.DeliverySequence)) === previous.ContentHash
          ) {
            continue;
          }
          throw new Error(`Conflicting equal-time ${category} fact in legacy delivery`);
        }
      }
      retained.push(row);
      dirtyDays.add(day);
      if (!previous || previous.EventDay === day) continue;
      const timestampField = category === 'review_unit_attributions' ? 'DecidedAt' : 'EventAt';
      const tombstone: Record<string, unknown> = {
        ...row,
        [timestampField]: `${previous.EventDay} 00:00:00.000`,
        IsDeleted: 1,
      };
      delete tombstone.ContentHash;
      tombstone.ContentHash = await sha256Hex(JSON.stringify(tombstone));
      tombstones.push(tombstone);
      dirtyDays.add(previous.EventDay);
    }
    rows.splice(0, rows.length, ...retained, ...tombstones);
  }
  return [...dirtyDays].sort();
}

async function lookupIdentityDays(
  env: PartitionLookupEnv,
  delivery: DeliveryRows,
  category: (typeof CATEGORIES)[number],
  identities: string[],
  oldestDay: string,
  today: string,
): Promise<IdentityDay[]> {
  const entries = await fetchPipe<IdentityDay>({
    baseUrl: env.TINYBIRD_HOST,
    token: env.TINYBIRD_AGENT_DELIVERY_READ_TOKEN,
    pipe: 'agent_fact_identity_day',
    params: {
      org_id: delivery.orgId,
      category,
      identities: factIdentityListParam(identities),
      oldest_day: oldestDay,
      today_day: today,
    },
    schema: {
      parse(value: unknown): IdentityDay {
        const entry = value as IdentityDay;
        if (
          !entry ||
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
      },
    },
  });
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!identities.includes(entry.FactIdentity) || seen.has(entry.FactIdentity)) {
      throw new Error('Unexpected or duplicate identity day response');
    }
    if (entry.DeliverySequence >= delivery.revision) {
      throw new Error('Fact identity already has this or a later delivery revision');
    }
    seen.add(entry.FactIdentity);
  }
  return entries;
}

async function contentHashAtRevision(
  row: Record<string, unknown>,
  revision: number,
): Promise<string> {
  const versioned: Record<string, unknown> = { ...row, DeliverySequence: revision, IsDeleted: 0 };
  delete versioned.ContentHash;
  return sha256Hex(JSON.stringify(versioned));
}

export function deliveryPartitionLinks(
  delivery: DeliveryRows,
): { oldDay: string; newDay: string }[] {
  const links = new Map<string, { oldDay: string; newDay: string }>();
  for (const category of CATEGORIES) {
    const rows = delivery.rows[category] as Record<string, unknown>[];
    const live = new Map(
      rows
        .filter((row) => row.IsDeleted === 0)
        .map((row) => [
          rowIdentity(row, ROW_IDENTITY_FIELDS[category]),
          factPartitionKey(category, row),
        ]),
    );
    for (const row of rows.filter((value) => value.IsDeleted === 1)) {
      const oldDay = factPartitionKey(category, row);
      const newDay = live.get(rowIdentity(row, ROW_IDENTITY_FIELDS[category]));
      if (!newDay || newDay === oldDay) throw new Error('Partition correction has no replacement');
      links.set(`${oldDay}:${newDay}`, { oldDay, newDay });
    }
  }
  return [...links.values()];
}
