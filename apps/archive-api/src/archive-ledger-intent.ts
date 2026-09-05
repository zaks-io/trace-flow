import { ArchiveContractError } from './archive-contract';
import type { ArchiveR2Object } from './archive-r2';
import { type ArchiveAcknowledgement, type LedgerCommit } from './archive-ledger-state';
import { persistLedgerCommit } from './archive-ledger-storage';
import type { PendingExpectedObject } from './archive-ledger-intent-state';

export {
  assertPendingIntentAuthenticated,
  decodePendingPlaintext,
  encodePendingPlaintext,
  pendingIntentStateHash,
  encryptPendingIntentState,
  type PendingExpectedObject,
} from './archive-ledger-intent-state';

export interface PendingIntent {
  intentHash: string;
  status: 'building' | 'ready' | 'committed';
  baseElementCount: number;
  baseChainHead: string;
  objects: ArchiveR2Object[];
  acknowledgement: ArchiveAcknowledgement;
  commit?: LedgerCommit;
  expectedObjects?: PendingExpectedObject[];
  stateHash?: string;
  stateAuthentication?: string;
}

const INTENT_PART_SIZE = 64 * 1024;

function splitString(value: string): string[] {
  const parts: string[] = [];
  for (let offset = 0; offset < value.length; offset += INTENT_PART_SIZE) {
    parts.push(value.slice(offset, offset + INTENT_PART_SIZE));
  }
  return parts.length > 0 ? parts : [''];
}

function readIntentMetadata(
  storage: DurableObjectStorage,
  intentHash: string,
): {
  acknowledgement: ArchiveAcknowledgement;
  objects?: { key: string; objectClass: ArchiveR2Object['objectClass']; partCount: number }[];
  commit?: LedgerCommit;
  expectedObjects?: PendingExpectedObject[];
  stateHash?: string;
  stateAuthentication?: string;
} {
  const parts = [
    ...storage.sql.exec<{ data: string }>(
      'SELECT data FROM pending_intent_metadata WHERE intent_hash = ? ORDER BY part_index',
      intentHash,
    ),
  ];
  if (parts.length === 0) throw new ArchiveContractError('pending_intent_corrupt');
  let metadata: {
    acknowledgement?: ArchiveAcknowledgement;
    objects?: {
      key: string;
      objectClass: ArchiveR2Object['objectClass'];
      partCount: number;
    }[];
    commit?: LedgerCommit;
    expectedObjects?: PendingExpectedObject[];
    stateHash?: string;
    stateAuthentication?: string;
  };
  try {
    metadata = JSON.parse(parts.map((part) => part.data).join('')) as typeof metadata;
  } catch {
    throw new ArchiveContractError('pending_intent_corrupt');
  }
  if (
    typeof metadata !== 'object' ||
    !metadata?.acknowledgement ||
    (metadata.objects !== undefined && !Array.isArray(metadata.objects)) ||
    (metadata.expectedObjects !== undefined && !Array.isArray(metadata.expectedObjects))
  ) {
    throw new ArchiveContractError('pending_intent_corrupt');
  }
  return {
    acknowledgement: metadata.acknowledgement,
    objects: metadata.objects,
    commit: metadata.commit,
    expectedObjects: metadata.expectedObjects,
    stateHash: metadata.stateHash,
    stateAuthentication: metadata.stateAuthentication,
  };
}

export function readIntent(
  storage: DurableObjectStorage,
  intentHash: string,
): PendingIntent | null {
  const row = [
    ...storage.sql.exec<{
      status: PendingIntent['status'];
      base_element_count: number;
      base_chain_head: string;
    }>(
      'SELECT status, base_element_count, base_chain_head FROM pending_intents WHERE intent_hash = ?',
      intentHash,
    ),
  ][0];
  if (!row) return null;
  const metadata = readIntentMetadata(storage, intentHash);
  if (row.status === 'committed') {
    return {
      intentHash,
      status: row.status,
      baseElementCount: row.base_element_count,
      baseChainHead: row.base_chain_head,
      objects: [],
      acknowledgement: metadata.acknowledgement,
    };
  }
  if (!metadata.objects) throw new ArchiveContractError('pending_intent_corrupt');
  if (
    !metadata.commit ||
    !metadata.expectedObjects ||
    !metadata.stateHash ||
    !metadata.stateAuthentication
  ) {
    throw new ArchiveContractError('pending_intent_corrupt');
  }
  const objects = metadata.objects.map((descriptor, objectIndex) => {
    const parts = [
      ...storage.sql.exec<{ data: string }>(
        'SELECT data FROM pending_intent_parts WHERE intent_hash = ? AND object_index = ? ORDER BY part_index',
        intentHash,
        objectIndex,
      ),
    ];
    const partCount = [
      ...storage.sql.exec<{ count: number }>(
        'SELECT COUNT(*) AS count FROM pending_intent_parts WHERE intent_hash = ? AND object_index = ?',
        intentHash,
        objectIndex,
      ),
    ][0]?.count;
    if (partCount !== descriptor.partCount || parts.length !== descriptor.partCount) {
      throw new ArchiveContractError('pending_intent_corrupt');
    }
    return {
      key: descriptor.key,
      body: parts.map((part) => part.data).join(''),
      objectClass: descriptor.objectClass,
    };
  });
  return {
    intentHash,
    status: row.status,
    baseElementCount: row.base_element_count,
    baseChainHead: row.base_chain_head,
    objects,
    acknowledgement: metadata.acknowledgement,
    commit: metadata.commit,
    expectedObjects: metadata.expectedObjects,
    stateHash: metadata.stateHash,
    stateAuthentication: metadata.stateAuthentication,
  };
}

export function readPendingIntent(storage: DurableObjectStorage): PendingIntent | null {
  const row = [
    ...storage.sql.exec<{ intent_hash: string }>(
      "SELECT intent_hash FROM pending_intents WHERE status IN ('building', 'ready') LIMIT 1",
    ),
  ][0];
  return row ? readIntent(storage, row.intent_hash) : null;
}

export function writeIntent(storage: DurableObjectStorage, intent: PendingIntent): void {
  if (
    !intent.commit ||
    !intent.expectedObjects ||
    !intent.stateHash ||
    !intent.stateAuthentication
  ) {
    throw new ArchiveContractError('pending_intent_corrupt');
  }
  const descriptors = intent.objects.map((object) => ({
    key: object.key,
    objectClass: object.objectClass,
    partCount: splitString(object.body).length,
  }));
  const metadata = JSON.stringify({
    acknowledgement: intent.acknowledgement,
    objects: descriptors,
    commit: intent.commit,
    expectedObjects: intent.expectedObjects,
    stateHash: intent.stateHash,
    stateAuthentication: intent.stateAuthentication,
  });
  storage.transactionSync(() => {
    storage.sql.exec(
      'INSERT INTO pending_intents (intent_hash, status, base_element_count, base_chain_head) VALUES (?, ?, ?, ?)',
      intent.intentHash,
      'building',
      intent.baseElementCount,
      intent.baseChainHead,
    );
    splitString(metadata).forEach((part, index) => {
      storage.sql.exec(
        'INSERT INTO pending_intent_metadata (intent_hash, part_index, data) VALUES (?, ?, ?)',
        intent.intentHash,
        index,
        part,
      );
    });
    intent.objects.forEach((object, objectIndex) => {
      splitString(object.body).forEach((part, partIndex) => {
        storage.sql.exec(
          'INSERT INTO pending_intent_parts (intent_hash, object_index, part_index, data) VALUES (?, ?, ?, ?)',
          intent.intentHash,
          objectIndex,
          partIndex,
          part,
        );
      });
    });
  });
}

export function markIntentReady(storage: DurableObjectStorage, intentHash: string): void {
  storage.transactionSync(() => {
    storage.sql.exec(
      'UPDATE pending_intents SET status = ? WHERE intent_hash = ? AND status = ?',
      'ready',
      intentHash,
      'building',
    );
  });
}

export function commitIntent(
  storage: DurableObjectStorage,
  intentHash: string,
  state: LedgerCommit,
  acknowledgement: ArchiveAcknowledgement,
): void {
  storage.transactionSync(() => {
    persistLedgerCommit(storage, state);
    storage.sql.exec('DELETE FROM pending_intent_parts WHERE intent_hash = ?', intentHash);
    storage.sql.exec('DELETE FROM pending_intent_metadata WHERE intent_hash = ?', intentHash);
    storage.sql.exec(
      'INSERT INTO pending_intent_metadata (intent_hash, part_index, data) VALUES (?, ?, ?)',
      intentHash,
      0,
      JSON.stringify({ acknowledgement }),
    );
    storage.sql.exec(
      'UPDATE pending_intents SET status = ? WHERE intent_hash = ?',
      'committed',
      intentHash,
    );
  });
}
