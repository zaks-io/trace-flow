import {
  CATEGORIES,
  LEGACY_CATEGORIES,
  MAX_FACT_INSERT_PARTITIONS,
  factPartitionKey,
  type Accumulator,
  type Category,
} from './facts';

export const MAX_NDJSON_BYTES = 900_000;

export type StoredFactRow = Record<string, string | number> & { id: number; data: string };

export interface AgentFactBatch {
  rows: Accumulator;
  writeClean?: boolean;
  writeLegacy?: boolean;
}

export interface AgentFactBatchResult {
  status: 'accepted' | 'failed';
  acceptedRows: number;
  duplicateRows: number;
  repairRows: number;
  blockedRecoveryRows: number;
  blockedRecoveryRecords: number;
}

export interface AgentFactBatcherStats {
  queuedRows: number;
  blockedRecoveryRows: number;
  blockedRecoveryRecords: number;
}

export function splitRowsByBytes(rows: StoredFactRow[]): StoredFactRow[][] {
  const batches: StoredFactRow[][] = [];
  let current: StoredFactRow[] = [];
  let bytes = 0;
  for (const row of rows) {
    const rowBytes = new TextEncoder().encode(row.data).byteLength + (current.length > 0 ? 1 : 0);
    if (current.length > 0 && bytes + rowBytes > MAX_NDJSON_BYTES) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(row);
    bytes += rowBytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function splitRowsByPartitions(
  rows: StoredFactRow[],
  facts: unknown[],
  category: Category,
): StoredFactRow[][] {
  const batches: StoredFactRow[][] = [];
  let current: StoredFactRow[] = [];
  let partitions = new Set<string>();
  for (let index = 0; index < rows.length; index++) {
    const partition = factPartitionKey(category, facts[index]);
    if (
      current.length > 0 &&
      !partitions.has(partition) &&
      partitions.size >= MAX_FACT_INSERT_PARTITIONS
    ) {
      batches.push(current);
      current = [];
      partitions = new Set();
    }
    current.push(rows[index]!);
    partitions.add(partition);
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function inlinePayload(value: string): string {
  return new TextEncoder().encode(value).byteLength <= MAX_NDJSON_BYTES ? value : '';
}

export function isPayloadTooLarge(error: unknown): boolean {
  return error instanceof Error && (error as Error & { status?: unknown }).status === 413;
}

export function parseFactTargetKey(value: string): {
  table: 'pending_facts' | 'legacy_pending_facts';
  category: Category;
} {
  const [table, category, extra] = value.split(':');
  if (extra || (table !== 'pending_facts' && table !== 'legacy_pending_facts')) {
    throw new Error('invalid fact recovery target');
  }
  if (!(CATEGORIES as readonly string[]).includes(category ?? '')) {
    throw new Error('invalid fact recovery category');
  }
  return { table, category: category as Category };
}

export function validateWriteTargets(batch: {
  rows: Accumulator;
  writeClean?: boolean;
  writeLegacy?: boolean;
}): void {
  const writesClean = batch.writeClean !== false;
  const writesLegacy = batch.writeLegacy === true;
  for (const category of CATEGORIES) {
    if (batch.rows[category].length === 0) continue;
    if (writesClean || (writesLegacy && (LEGACY_CATEGORIES as Category[]).includes(category))) {
      continue;
    }
    throw new Error(`no Tinybird write target for ${category}`);
  }
}

export function dlqPayloadOrgId(payload: string): string | null {
  const parsed: unknown = JSON.parse(payload);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const body = (parsed as Record<string, unknown>).body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const tenancy = (body as Record<string, unknown>).tenancy;
  if (!tenancy || typeof tenancy !== 'object' || Array.isArray(tenancy)) return null;
  const orgId = (tenancy as Record<string, unknown>).org_id;
  return typeof orgId === 'string' ? orgId : null;
}
