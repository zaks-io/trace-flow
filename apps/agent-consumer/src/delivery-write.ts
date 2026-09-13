import { insertRows, fetchPipe } from '@trace-flow/tinybird-client';
import {
  ROW_IDENTITY_FIELDS,
  MAX_FACT_INSERT_PARTITIONS,
  factPartitionKey,
  rowIdentity,
  type Category,
} from './facts';

export const FACT_VERSION_DATASOURCES: Record<Category, string> = {
  messages: 'agent_message_fact_versions',
  tool_events: 'agent_tool_event_fact_versions',
  file_events: 'agent_file_event_fact_versions',
  capability_snapshots: 'agent_capability_snapshot_fact_versions',
  pull_request_links: 'agent_pull_request_fact_versions',
  review_unit_attributions: 'agent_review_unit_attribution_versions',
};

interface DeliveryWriteEnv {
  TINYBIRD_TOKEN: string;
  TINYBIRD_AGENT_DELIVERY_READ_TOKEN: string;
  TINYBIRD_HOST: string;
}

interface ReceiptRow {
  FactIdentity: string;
  EventDay: string;
  IsDeleted: number;
  ContentHash: string;
}

function receiptIdentity(row: ReceiptRow): string {
  return `${row.FactIdentity}\x1f${row.EventDay}\x1f${row.IsDeleted}`;
}

function expectedReceipt(row: unknown, category: Category): ReceiptRow {
  const value = row as Record<string, unknown>;
  if (typeof value.ContentHash !== 'string' || ![0, 1].includes(value.IsDeleted as number)) {
    throw new Error('Invalid canonical delivery row');
  }
  return {
    FactIdentity: rowIdentity(row, ROW_IDENTITY_FIELDS[category]),
    EventDay: factPartitionKey(category, row),
    IsDeleted: value.IsDeleted as number,
    ContentHash: value.ContentHash,
  };
}

/** Reconcile an ambiguous previous write through the short-lived, delivery-keyed receipt index. */
export async function deliveryCategoryIsPresent(
  env: DeliveryWriteEnv,
  orgId: string,
  revision: number,
  category: Category,
  rows: unknown[],
): Promise<boolean> {
  const receipts = await fetchPipe<ReceiptRow>({
    baseUrl: env.TINYBIRD_HOST,
    token: env.TINYBIRD_AGENT_DELIVERY_READ_TOKEN,
    pipe: 'agent_delivery_receipt',
    params: { org_id: orgId, delivery_sequence: revision, category },
    schema: {
      parse(value: unknown): ReceiptRow {
        if (
          !value ||
          typeof value !== 'object' ||
          typeof (value as ReceiptRow).FactIdentity !== 'string' ||
          typeof (value as ReceiptRow).EventDay !== 'string' ||
          ![0, 1].includes((value as ReceiptRow).IsDeleted) ||
          typeof (value as ReceiptRow).ContentHash !== 'string'
        ) {
          throw new Error('Invalid agent delivery receipt');
        }
        return value as ReceiptRow;
      },
    },
  });
  const expected = new Set(rows.map((row) => receiptIdentity(expectedReceipt(row, category))));
  const actual = new Map<string, string>();
  for (const receipt of receipts) {
    const identity = receiptIdentity(receipt);
    if (!expected.has(identity)) throw new Error('Unexpected identities in delivery receipt');
    const previous = actual.get(identity);
    if (previous !== undefined && previous !== receipt.ContentHash) {
      throw new Error('Delivery receipt content conflict');
    }
    actual.set(identity, receipt.ContentHash);
  }
  let complete = actual.size === rows.length;
  for (const row of rows) {
    const identity = receiptIdentity(expectedReceipt(row, category));
    const hash = actual.get(identity);
    if (hash === undefined) complete = false;
    else if (hash !== (row as Record<string, unknown>).ContentHash) {
      throw new Error('Delivery receipt content conflict');
    }
  }
  return complete;
}

export async function writeDeliveryCategory(
  env: DeliveryWriteEnv,
  category: Category,
  rows: unknown[],
): Promise<void> {
  const partitions = new Map<string, unknown[]>();
  for (const row of rows) {
    const day = factPartitionKey(category, row);
    const partition = partitions.get(day) ?? [];
    partition.push(row);
    partitions.set(day, partition);
  }
  const groups = [...partitions.values()];
  for (let offset = 0; offset < groups.length; offset += MAX_FACT_INSERT_PARTITIONS) {
    await insertRows(
      groups.slice(offset, offset + MAX_FACT_INSERT_PARTITIONS).flat(),
      env.TINYBIRD_TOKEN,
      FACT_VERSION_DATASOURCES[category],
      env.TINYBIRD_HOST,
    );
  }
}
