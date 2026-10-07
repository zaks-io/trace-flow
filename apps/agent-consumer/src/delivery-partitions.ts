import { sha256Hex } from '@trace-flow/utils';
import {
  CATEGORIES,
  ROW_IDENTITY_FIELDS,
  factIngestedAtMs,
  factPartitionKey,
  rowIdentity,
  type Category,
} from './facts';
import { lookupFactIdentityDays } from './fact-identity-days';
import type { DeliveryRows } from './delivery-rows';

interface PartitionLookupEnv {
  TINYBIRD_HOST: string;
  TINYBIRD_AGENT_DELIVERY_READ_TOKEN: string;
}

/** The caller holds the organization's write permit until this exact plan is committed. */
export async function prepareDeliveryPartitions(
  env: PartitionLookupEnv,
  delivery: DeliveryRows,
  options: { legacySourceOrder?: boolean } = {},
): Promise<string[]> {
  const dirtyDays = new Set<string>();
  const identities: Partial<Record<Category, string[]>> = {};
  for (const category of CATEGORIES) {
    identities[category] = (delivery.rows[category] as Record<string, unknown>[]).map((row) =>
      rowIdentity(row, ROW_IDENTITY_FIELDS[category]),
    );
  }
  // Finish every lookup before changing rows, so a failed request leaves the persisted recovery
  // plan intact.
  const identityDays = await lookupFactIdentityDays(env, delivery.orgId, identities);
  for (const category of CATEGORIES) {
    for (const entry of identityDays[category].values()) {
      if (entry.DeliverySequence >= delivery.revision) {
        throw new Error('Fact identity already has this or a later delivery revision');
      }
    }
  }
  for (const category of CATEGORIES) {
    const rows = delivery.rows[category] as Record<string, unknown>[];
    const retained: Record<string, unknown>[] = [];
    const tombstones: Record<string, unknown>[] = [];
    const byIdentity = identityDays[category];
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
