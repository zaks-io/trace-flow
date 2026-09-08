import type { ArchiveApiEnv } from './context';
import { ArchiveContractError } from './archive-contract';
import { commitIntent, discardPendingIntent, type PendingIntent } from './archive-ledger-intent';
import { storageBudgetObject } from './archive-r2';
import type { StorageBudgetObject } from './archive-storage-budget';

interface PendingRelease {
  orgId: string;
  object: StorageBudgetObject & { keyVersion: number };
}

export function ensurePendingReleaseSchema(storage: DurableObjectStorage): void {
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS pending_releases (
      object_key TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      object_class TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      expires_at TEXT,
      key_version INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pending_budget_commits (
      object_key TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      object_class TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      expires_at TEXT,
      key_version INTEGER NOT NULL
    );
  `);
}

function releaseObjects(pending: PendingIntent): PendingRelease[] {
  const orgId = pending.commit?.scope.orgId;
  const keyVersion = pending.commit?.keyVersion;
  if (
    !orgId ||
    typeof keyVersion !== 'number' ||
    !Number.isSafeInteger(keyVersion) ||
    keyVersion < 1
  ) {
    throw new ArchiveContractError('pending_intent_corrupt');
  }
  return pending.objects.map((item) => ({
    orgId,
    object: { ...storageBudgetObject(item, keyVersion), keyVersion },
  }));
}

function insertPendingRelease(storage: DurableObjectStorage, release: PendingRelease): void {
  const { orgId, object } = release;
  const existing = [
    ...storage.sql.exec<{
      org_id: string;
      object_class: string;
      bytes: number;
      expires_at: string | null;
      key_version: number;
    }>(
      'SELECT org_id, object_class, bytes, expires_at, key_version FROM pending_releases WHERE object_key = ?',
      object.objectKey,
    ),
  ][0];
  if (existing) {
    if (
      existing.org_id !== orgId ||
      existing.object_class !== object.objectClass ||
      existing.bytes !== object.bytes ||
      existing.expires_at !== object.expiresAt ||
      existing.key_version !== object.keyVersion
    ) {
      throw new ArchiveContractError('pending_release_corrupt');
    }
    return;
  }
  storage.sql.exec(
    'INSERT INTO pending_releases (object_key, org_id, object_class, bytes, expires_at, key_version) VALUES (?, ?, ?, ?, ?, ?)',
    object.objectKey,
    orgId,
    object.objectClass,
    object.bytes,
    object.expiresAt,
    object.keyVersion,
  );
}

export function discardIntentAndEnqueueRelease(
  storage: DurableObjectStorage,
  pending: PendingIntent,
  mode: 'unreserved_only' | 'proven_unwritten',
): void {
  const releases = releaseObjects(pending);
  const discarded = discardPendingIntent(storage, pending.intentHash, mode, () => {
    for (const release of releases) insertPendingRelease(storage, release);
  });
  if (!discarded) throw new ArchiveContractError('pending_intent_corrupt');
}

export async function discardIntentAndRelease(
  storage: DurableObjectStorage,
  env: Pick<ArchiveApiEnv, 'STORAGE_BUDGET'>,
  pending: PendingIntent,
  mode: 'unreserved_only' | 'proven_unwritten',
): Promise<void> {
  discardIntentAndEnqueueRelease(storage, pending, mode);
  await drainPendingReleases(storage, env);
}

export function hasPendingReleases(storage: DurableObjectStorage): boolean {
  return (
    [...storage.sql.exec<{ object_key: string }>('SELECT object_key FROM pending_releases LIMIT 1')]
      .length > 0
  );
}

export function hasPendingBudgetCommits(storage: DurableObjectStorage): boolean {
  return (
    [
      ...storage.sql.exec<{ object_key: string }>(
        'SELECT object_key FROM pending_budget_commits LIMIT 1',
      ),
    ].length > 0
  );
}

function insertPendingBudgetCommit(storage: DurableObjectStorage, pending: PendingRelease): void {
  const { orgId, object } = pending;
  const existing = [
    ...storage.sql.exec<{
      org_id: string;
      object_class: string;
      bytes: number;
      expires_at: string | null;
      key_version: number;
    }>(
      'SELECT org_id, object_class, bytes, expires_at, key_version FROM pending_budget_commits WHERE object_key = ?',
      object.objectKey,
    ),
  ][0];
  if (existing) {
    if (
      existing.org_id !== orgId ||
      existing.object_class !== object.objectClass ||
      existing.bytes !== object.bytes ||
      existing.expires_at !== object.expiresAt ||
      existing.key_version !== object.keyVersion
    ) {
      throw new ArchiveContractError('pending_budget_commit_corrupt');
    }
    return;
  }
  storage.sql.exec(
    'INSERT INTO pending_budget_commits (object_key, org_id, object_class, bytes, expires_at, key_version) VALUES (?, ?, ?, ?, ?, ?)',
    object.objectKey,
    orgId,
    object.objectClass,
    object.bytes,
    object.expiresAt,
    object.keyVersion,
  );
}

export function commitIntentAndEnqueueBudgetCommit(
  storage: DurableObjectStorage,
  pending: PendingIntent,
): void {
  if (!pending.commit) throw new ArchiveContractError('pending_intent_corrupt');
  const commits = releaseObjects(pending);
  commitIntent(storage, pending.intentHash, pending.commit, pending.acknowledgement, () => {
    for (const commit of commits) insertPendingBudgetCommit(storage, commit);
  });
}

function readPendingReleases(storage: DurableObjectStorage): PendingRelease[] {
  return [
    ...storage.sql.exec<{
      object_key: string;
      org_id: string;
      object_class: StorageBudgetObject['objectClass'];
      bytes: number;
      expires_at: string | null;
      key_version: number;
    }>(
      'SELECT object_key, org_id, object_class, bytes, expires_at, key_version FROM pending_releases ORDER BY org_id, object_key',
    ),
  ].map((row) => {
    if (
      !row.org_id ||
      (row.object_class !== 'agent_archive_chunk' &&
        row.object_class !== 'agent_archive_manifest') ||
      !Number.isSafeInteger(row.bytes) ||
      row.bytes < 0 ||
      !Number.isSafeInteger(row.key_version) ||
      row.key_version < 1
    ) {
      throw new ArchiveContractError('pending_release_corrupt');
    }
    return {
      orgId: row.org_id,
      object: {
        objectKey: row.object_key,
        objectClass: row.object_class,
        bytes: row.bytes,
        expiresAt: row.expires_at,
        keyVersion: row.key_version,
      },
    };
  });
}

export async function drainPendingReleases(
  storage: DurableObjectStorage,
  env: Pick<ArchiveApiEnv, 'STORAGE_BUDGET'>,
): Promise<void> {
  const grouped = new Map<string, PendingRelease[]>();
  for (const release of readPendingReleases(storage)) {
    const releases = grouped.get(release.orgId) ?? [];
    releases.push(release);
    grouped.set(release.orgId, releases);
  }
  for (const [orgId, releases] of grouped) {
    const objects = releases.map(({ object }) => object);
    await env.STORAGE_BUDGET.getByName(orgId).releaseStorage({ orgId, objects });
    storage.transactionSync(() => {
      for (const { object } of releases) {
        storage.sql.exec('DELETE FROM pending_releases WHERE object_key = ?', object.objectKey);
      }
    });
  }
}

export async function drainPendingBudgetCommits(
  storage: DurableObjectStorage,
  env: Pick<ArchiveApiEnv, 'STORAGE_BUDGET'>,
): Promise<void> {
  const grouped = new Map<string, PendingRelease[]>();
  for (const pending of readPendingBudgetCommits(storage)) {
    const commits = grouped.get(pending.orgId) ?? [];
    commits.push(pending);
    grouped.set(pending.orgId, commits);
  }
  for (const [orgId, commits] of grouped) {
    const objects = commits.map(({ object }) => object);
    const budget = env.STORAGE_BUDGET.getByName(orgId);
    await budget.commitStorage({ orgId, objects });
    await budget.recordArchiveAcknowledgement({ orgId, acknowledgedAt: Date.now() });
    storage.transactionSync(() => {
      for (const { object } of commits) {
        storage.sql.exec(
          'DELETE FROM pending_budget_commits WHERE object_key = ?',
          object.objectKey,
        );
      }
    });
  }
}

function readPendingBudgetCommits(storage: DurableObjectStorage): PendingRelease[] {
  return [
    ...storage.sql.exec<{
      object_key: string;
      org_id: string;
      object_class: StorageBudgetObject['objectClass'];
      bytes: number;
      expires_at: string | null;
      key_version: number;
    }>(
      'SELECT object_key, org_id, object_class, bytes, expires_at, key_version FROM pending_budget_commits ORDER BY org_id, object_key',
    ),
  ].map((row) => {
    if (
      !row.org_id ||
      (row.object_class !== 'agent_archive_chunk' &&
        row.object_class !== 'agent_archive_manifest') ||
      !Number.isSafeInteger(row.bytes) ||
      row.bytes < 0 ||
      !Number.isSafeInteger(row.key_version) ||
      row.key_version < 1
    ) {
      throw new ArchiveContractError('pending_budget_commit_corrupt');
    }
    return {
      orgId: row.org_id,
      object: {
        objectKey: row.object_key,
        objectClass: row.object_class,
        bytes: row.bytes,
        expiresAt: row.expires_at,
        keyVersion: row.key_version,
      },
    };
  });
}
