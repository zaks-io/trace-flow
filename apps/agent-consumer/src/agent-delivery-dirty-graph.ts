import {
  AgentDeliveryCoordinatorRetryableError,
  MAX_AGENT_DIRTY_DAY_LINK_NODES,
  MAX_AGENT_DIRTY_DAY_LINKS,
  MAX_AGENT_SNAPSHOT_DAYS,
  type AgentDirtyDayLink,
} from './agent-delivery-coordinator-contract';
import { countRows, readDeliveryDays } from './agent-delivery-coordinator-storage';
import { earliestDeliveryId, requireStoredReservation } from './agent-delivery-reservations';
import {
  assertExactKeys,
  assertRetainedDaySet,
  validateDaySet,
  validateDeliveryId,
  validatePayloadSha256,
} from './agent-delivery-coordinator-validation';

type StoredDirtyDayLink = Record<string, string> & {
  day_a: string;
  day_b: string;
};

export function linkDirtyDays(
  storage: DurableObjectStorage,
  input: {
    deliveryId: string;
    payloadSha256: string;
    links: AgentDirtyDayLink[];
  },
  now: number,
): { linkedEdges: number } {
  assertExactKeys(input, ['deliveryId', 'links', 'payloadSha256'], 'link dirty days');
  const deliveryId = validateDeliveryId(input.deliveryId);
  const payloadSha256 = validatePayloadSha256(input.payloadSha256);
  const links = validateDirtyDayLinks(input.links, now);

  return storage.transactionSync(() => {
    const reservation = requireStoredReservation(storage, deliveryId, payloadSha256);
    if (now >= reservation.expires_at_ms) throw new Error('active delivery has expired');
    if (earliestDeliveryId(storage) !== reservation.delivery_id) {
      throw new AgentDeliveryCoordinatorRetryableError(
        'active delivery does not hold write permit',
      );
    }
    const expandedDays = new Set(readDeliveryDays(storage, deliveryId));
    for (const [dayA, dayB] of links) {
      if (!expandedDays.has(dayA) || !expandedDays.has(dayB)) {
        throw new Error('linked dirty days must already be expanded for the active delivery');
      }
      storage.sql.exec(
        'INSERT OR IGNORE INTO dirty_day_links (day_a, day_b) VALUES (?, ?)',
        dayA,
        dayB,
      );
    }
    assertGraphCapacity(storage);
    return { linkedEdges: links.length };
  });
}

export function selectSnapshotDirtyDays(storage: DurableObjectStorage): string[] {
  const dirtyDays = [
    ...storage.sql.exec<{ dirty_day: string }>('SELECT dirty_day FROM dirty_days'),
  ].map((row) => row.dirty_day);
  const dirtyDaySet = new Set(dirtyDays);
  const incompleteDays = new Set(
    [...storage.sql.exec<{ dirty_day: string }>('SELECT dirty_day FROM incomplete_days')].map(
      (row) => row.dirty_day,
    ),
  );
  const adjacency = new Map(dirtyDays.map((dirtyDay) => [dirtyDay, new Set<string>()]));
  for (const { day_a: dayA, day_b: dayB } of storage.sql.exec<StoredDirtyDayLink>(
    'SELECT day_a, day_b FROM dirty_day_links',
  )) {
    if (!dirtyDaySet.has(dayA) || !dirtyDaySet.has(dayB)) continue;
    adjacency.get(dayA)!.add(dayB);
    adjacency.get(dayB)!.add(dayA);
  }

  const visited = new Set<string>();
  const components: string[][] = [];
  for (const dirtyDay of dirtyDays) {
    if (visited.has(dirtyDay)) continue;
    const component: string[] = [];
    const pending = [dirtyDay];
    visited.add(dirtyDay);
    while (pending.length > 0) {
      const current = pending.pop()!;
      component.push(current);
      for (const linkedDay of adjacency.get(current)!) {
        if (visited.has(linkedDay)) continue;
        visited.add(linkedDay);
        pending.push(linkedDay);
      }
    }
    component.sort();
    if (!component.some((day) => incompleteDays.has(day))) components.push(component);
  }

  components.sort((left, right) => right.at(-1)!.localeCompare(left.at(-1)!));
  const selected: string[] = [];
  for (const component of components) {
    if (selected.length === 0 && component.length > MAX_AGENT_SNAPSHOT_DAYS) return component;
    if (selected.length + component.length <= MAX_AGENT_SNAPSHOT_DAYS) {
      selected.push(...component);
    }
  }
  return selected.sort();
}

export function deleteCapturedDirtyDayLinks(
  storage: DurableObjectStorage,
  generation: number,
): void {
  storage.sql.exec(
    `DELETE FROM dirty_day_links
     WHERE day_a IN (SELECT dirty_day FROM snapshot_days WHERE generation = ?)
       AND day_b IN (SELECT dirty_day FROM snapshot_days WHERE generation = ?)`,
    generation,
    generation,
  );
}

function validateDirtyDayLinks(value: unknown, now: number): [string, string][] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('dirty day links must be a non-empty array');
  }
  if (value.length > MAX_AGENT_DIRTY_DAY_LINKS) {
    throw new Error('delivery has too many dirty day links');
  }
  const links = new Map<string, [string, string]>();
  for (const link of value) {
    assertExactKeys(link, ['newDay', 'oldDay'], 'dirty day link');
    const days = validateDaySet(
      [(link as AgentDirtyDayLink).oldDay, (link as AgentDirtyDayLink).newDay],
      'dirty day link',
    );
    if (days.length !== 2) throw new Error('dirty day link endpoints must differ');
    links.set(`${days[0]}:${days[1]}`, [days[0]!, days[1]!]);
  }
  const normalized = [...links.values()];
  assertRetainedDaySet(normalized.flat(), now);
  return normalized;
}

function assertGraphCapacity(storage: DurableObjectStorage): void {
  const nodes = storage.sql
    .exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM (
         SELECT day_a AS dirty_day FROM dirty_day_links
         UNION
         SELECT day_b AS dirty_day FROM dirty_day_links
       )`,
    )
    .one().count;
  if (nodes > MAX_AGENT_DIRTY_DAY_LINK_NODES) {
    throw new AgentDeliveryCoordinatorRetryableError('dirty day link node limit reached');
  }
  if (countRows(storage, 'dirty_day_links') > MAX_AGENT_DIRTY_DAY_LINKS) {
    throw new AgentDeliveryCoordinatorRetryableError('dirty day link limit reached');
  }
}
