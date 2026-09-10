import { ArchiveContractError, assertIdentifier } from './archive-contract';

const ERASURE_KEY = 'archive_erasure';
const LEDGER_PREFIX = 'archive_ledger:';
const DEFAULT_LEDGER_PAGE_SIZE = 100;

interface ArchiveErasureMarker {
  orgId: string;
}

function assertLedgerId(ledgerId: string): void {
  if (!/^[a-f0-9]{64}$/u.test(ledgerId)) {
    throw new ArchiveContractError('archive_ledger_id_invalid');
  }
}

async function marker(storage: DurableObjectStorage): Promise<ArchiveErasureMarker | undefined> {
  return await storage.get<ArchiveErasureMarker>(ERASURE_KEY);
}

export async function assertArchiveErasureStarted(
  storage: DurableObjectStorage,
  orgId: string,
): Promise<void> {
  assertIdentifier(orgId, 'invalid_organization_id');
  const stored = await marker(storage);
  if (stored?.orgId !== orgId) {
    throw new ArchiveContractError('archive_erasure_not_started');
  }
}

export async function assertArchiveWritable(storage: DurableObjectStorage): Promise<void> {
  if (await marker(storage)) throw new ArchiveContractError('archive_deleting');
}

export async function beginArchiveErasureState(
  storage: DurableObjectStorage,
  orgId: string,
): Promise<void> {
  assertIdentifier(orgId, 'invalid_organization_id');
  const stored = await marker(storage);
  if (stored && stored.orgId !== orgId) {
    throw new ArchiveContractError('storage_budget_identity_mismatch');
  }
  if (!stored) await storage.put(ERASURE_KEY, { orgId });
}

export async function registerArchiveLedger(
  storage: DurableObjectStorage,
  orgId: string,
  ledgerId: string,
): Promise<void> {
  assertIdentifier(orgId, 'invalid_organization_id');
  assertLedgerId(ledgerId);
  await assertArchiveWritable(storage);
  await storage.put(`${LEDGER_PREFIX}${ledgerId}`, orgId);
}

export async function registeredArchiveLedgers(
  storage: DurableObjectStorage,
  orgId: string,
  cursor?: string,
  limit = DEFAULT_LEDGER_PAGE_SIZE,
): Promise<{ ledgerIds: string[]; cursor?: string }> {
  await assertArchiveErasureStarted(storage, orgId);
  if (cursor !== undefined) assertLedgerId(cursor);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > DEFAULT_LEDGER_PAGE_SIZE) {
    throw new ArchiveContractError('archive_erasure_page_invalid');
  }
  const rows = await storage.list<string>({
    prefix: LEDGER_PREFIX,
    ...(cursor === undefined ? {} : { startAfter: `${LEDGER_PREFIX}${cursor}` }),
    limit,
  });
  const ledgerIds: string[] = [];
  for (const [key, storedOrgId] of rows) {
    if (storedOrgId !== orgId || !key.startsWith(LEDGER_PREFIX)) {
      throw new ArchiveContractError('storage_budget_identity_mismatch');
    }
    const ledgerId = key.slice(LEDGER_PREFIX.length);
    assertLedgerId(ledgerId);
    ledgerIds.push(ledgerId);
  }
  const nextCursor = ledgerIds.length === limit ? ledgerIds.at(-1) : undefined;
  return { ledgerIds, ...(nextCursor === undefined ? {} : { cursor: nextCursor }) };
}

export async function clearArchiveBudgetState(storage: DurableObjectStorage): Promise<void> {
  const registry = await storage.list({ prefix: LEDGER_PREFIX, limit: 1 });
  if (registry.size > 0) throw new ArchiveContractError('archive_erasure_registry_not_empty');
  const tables = [
    ...storage.sql.exec<{ name: string }>(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND (name LIKE 'storage_budget_%' OR name LIKE 'archive_key_%')",
    ),
  ];
  storage.transactionSync(() => {
    for (const { name } of tables) {
      if (!/^[a-z0-9_]+$/u.test(name)) {
        throw new ArchiveContractError('storage_budget_schema_invalid');
      }
      storage.sql.exec(`DELETE FROM "${name}"`);
    }
  });
  await storage.deleteAlarm();
}

export async function removeRegisteredArchiveLedgers(
  storage: DurableObjectStorage,
  orgId: string,
  ledgerIds: string[],
): Promise<void> {
  await assertArchiveErasureStarted(storage, orgId);
  const keys = ledgerIds.map((ledgerId) => {
    assertLedgerId(ledgerId);
    return `${LEDGER_PREFIX}${ledgerId}`;
  });
  const rows = await storage.get<string>(keys);
  for (const key of keys) {
    if (rows.get(key) !== orgId) {
      throw new ArchiveContractError('storage_budget_identity_mismatch');
    }
  }
  if (keys.length > 0) await storage.delete(keys);
}

export async function markLedgerErased(
  storage: DurableObjectStorage,
  orgId: string,
): Promise<void> {
  assertIdentifier(orgId, 'invalid_organization_id');
  const stored = await marker(storage);
  if (stored && stored.orgId !== orgId) {
    throw new ArchiveContractError('ledger_scope_mismatch');
  }
  if (!stored) await storage.put(ERASURE_KEY, { orgId });
}

export async function ledgerErasureOrgId(
  storage: DurableObjectStorage,
): Promise<string | undefined> {
  return (await marker(storage))?.orgId;
}

export function clearLedgerSqlState(storage: DurableObjectStorage): void {
  const tables = [
    ...storage.sql.exec<{ name: string }>(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND (name LIKE 'ledger_%' OR name LIKE 'pending_%')",
    ),
  ];
  storage.transactionSync(() => {
    for (const { name } of tables) {
      if (!/^[a-z0-9_]+$/u.test(name)) {
        throw new ArchiveContractError('ledger_schema_invalid');
      }
      storage.sql.exec(`DELETE FROM "${name}"`);
    }
  });
}
