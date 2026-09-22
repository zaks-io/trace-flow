import type { ArchiveApiEnv } from './context';
import { ArchiveContractError, type ArchiveScope } from './archive-contract';
import type { LedgerSnapshot } from './archive-ledger-state';

const MAX_CATALOG_PAGE_SIZE = 100;

export interface ArchiveSessionCatalogEntry {
  ledgerId: string;
  userId: string;
  contributionId: string;
  source: ArchiveScope['source'];
  sourceSessionId: string;
  manifestKey: string;
  manifestHeadPageKey: string;
  generation: number;
  elementCount: number;
  recordCount: number;
  chainHead: string;
}

function ledgerStub(env: ArchiveApiEnv, ledgerId: string) {
  let id: DurableObjectId;
  try {
    id = env.ARCHIVE_SESSION_LEDGER.idFromString(ledgerId);
  } catch {
    throw new ArchiveContractError('archive_ledger_id_invalid');
  }
  return env.ARCHIVE_SESSION_LEDGER.get(id);
}

function committedEntry(
  ledgerId: string,
  snapshot: LedgerSnapshot | null,
): ArchiveSessionCatalogEntry | null {
  if (!snapshot?.scope || !snapshot.manifestKey || !snapshot.keyVersion) return null;
  return {
    ledgerId,
    userId: snapshot.scope.userId,
    contributionId: snapshot.scope.contributionId,
    source: snapshot.scope.source,
    sourceSessionId: snapshot.scope.sourceSessionId,
    manifestKey: snapshot.manifestKey,
    manifestHeadPageKey: snapshot.manifestHeadPageKey ?? snapshot.manifestKey,
    generation: snapshot.generation,
    elementCount: snapshot.elementCount,
    recordCount: snapshot.recordCount,
    chainHead: snapshot.chainHead,
  };
}

async function readCommittedSnapshot(
  env: ArchiveApiEnv,
  ledgerId: string,
): Promise<LedgerSnapshot | null> {
  const snapshot = await ledgerStub(env, ledgerId).exportCatalogEntry();
  return snapshot?.scope && snapshot.manifestKey && snapshot.keyVersion ? snapshot : null;
}

export async function listArchiveSessionCatalog(
  env: ArchiveApiEnv,
  orgId: string,
  cursor?: string,
): Promise<{ sessions: ArchiveSessionCatalogEntry[]; cursor?: string }> {
  const page = await env.STORAGE_BUDGET.getByName(orgId).listArchiveLedgersForOrganization({
    orgId,
    ...(cursor === undefined ? {} : { cursor }),
    limit: MAX_CATALOG_PAGE_SIZE,
  });
  const sessions: ArchiveSessionCatalogEntry[] = [];
  for (const ledgerId of page.ledgerIds) {
    const snapshot = await readCommittedSnapshot(env, ledgerId);
    if (!snapshot) continue;
    if (snapshot.scope!.orgId !== orgId) {
      throw new ArchiveContractError('storage_budget_identity_mismatch');
    }
    sessions.push(committedEntry(ledgerId, snapshot)!);
  }
  return { sessions, ...(page.cursor === undefined ? {} : { cursor: page.cursor }) };
}

export async function registerCommittedArchiveLedgers(
  env: ArchiveApiEnv,
  ledgerIds: string[],
): Promise<{ inspected: number; committed: number; registered: number }> {
  if (ledgerIds.length < 1 || ledgerIds.length > 100) {
    throw new ArchiveContractError('archive_registry_page_invalid');
  }
  let committed = 0;
  let registered = 0;
  for (const ledgerId of ledgerIds) {
    const snapshot = await readCommittedSnapshot(env, ledgerId);
    if (!snapshot) continue;
    committed += 1;
    const orgId = snapshot?.scope?.orgId;
    if (!orgId) throw new ArchiveContractError('ledger_state_corrupt');
    await env.STORAGE_BUDGET.getByName(orgId).registerLedger({ orgId, ledgerId });
    registered += 1;
  }
  return { inspected: ledgerIds.length, committed, registered };
}
