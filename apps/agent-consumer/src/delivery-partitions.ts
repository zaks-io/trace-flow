import { fetchPipe } from '@trace-flow/tinybird-client';
import { agentAnalyticsDayBounds, sha256Hex } from '@trace-flow/utils';
import {
  CATEGORIES,
  ROW_IDENTITY_FIELDS,
  factIdentityListParam,
  factPartitionKey,
  rowIdentity,
} from './facts';
import type { DeliveryRows } from './delivery-rows';

interface PartitionLookupEnv {
  TINYBIRD_HOST: string;
  TINYBIRD_AGENT_DELIVERY_READ_TOKEN: string;
}

interface IdentityDay {
  FactIdentity: string;
  EventDay: string;
  DeliverySequence: number;
}

/** The caller holds the organization's write permit until this exact plan is committed. */
export async function prepareDeliveryPartitions(
  env: PartitionLookupEnv,
  delivery: DeliveryRows,
): Promise<string[]> {
  const { oldestDay, today } = agentAnalyticsDayBounds(Date.now());
  const dirtyDays = new Set<string>();
  for (const category of CATEGORIES) {
    const rows = delivery.rows[category] as Record<string, unknown>[];
    const tombstones: Record<string, unknown>[] = [];
    for (let offset = 0; offset < rows.length; offset += 32) {
      const chunk = rows.slice(offset, offset + 32);
      const identities = chunk.map((row) => rowIdentity(row, ROW_IDENTITY_FIELDS[category]));
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
              Number(entry.DeliverySequence) < 1
            ) {
              throw new Error('Invalid fact identity day response');
            }
            return { ...entry, DeliverySequence: Number(entry.DeliverySequence) };
          },
        },
      });
      const byIdentity = new Map<string, IdentityDay>();
      for (const entry of entries) {
        if (!identities.includes(entry.FactIdentity) || byIdentity.has(entry.FactIdentity)) {
          throw new Error('Unexpected or duplicate identity day response');
        }
        if (entry.DeliverySequence >= delivery.revision) {
          throw new Error('Fact identity already has this or a later delivery revision');
        }
        byIdentity.set(entry.FactIdentity, entry);
      }
      for (const row of chunk) {
        const day = factPartitionKey(category, row);
        dirtyDays.add(day);
        const previous = byIdentity.get(rowIdentity(row, ROW_IDENTITY_FIELDS[category]));
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
    }
    rows.push(...tombstones);
  }
  return [...dirtyDays].sort();
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
