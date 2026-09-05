import { ArchiveContractError, decodeBase64Bytes } from './archive-contract';
import type { ArchiveR2Object } from './archive-r2';
import type { LedgerCommit } from './archive-ledger-state';
import { intentDigest } from './archive-ledger-support';
import {
  decryptArchiveObject,
  encryptArchiveObject,
  type ArchiveObjectEnvelope,
} from '@trace-flow/utils';

export interface PendingExpectedObject {
  key: string;
  objectClass: ArchiveR2Object['objectClass'];
  plaintextBase64: string;
}

export async function pendingIntentStateHash(
  intentHash: string,
  commit: LedgerCommit,
  expectedObjects: PendingExpectedObject[],
): Promise<string> {
  return intentDigest({ intentHash, commit, expectedObjects });
}

function pendingIntentObjectKey(intentHash: string): string {
  return `pending-intent/${intentHash}`;
}

export async function encryptPendingIntentState(
  intentHash: string,
  commit: LedgerCommit,
  expectedObjects: PendingExpectedObject[],
  key: CryptoKey,
  orgId: string,
  keyVersion: number,
): Promise<string> {
  const plaintext = new TextEncoder().encode(
    JSON.stringify({ intentHash, commit, expectedObjects }),
  );
  const envelope = await encryptArchiveObject(plaintext, {
    key,
    orgId,
    objectKey: pendingIntentObjectKey(intentHash),
    objectClass: 'manifest',
    keyVersion,
  });
  return JSON.stringify(envelope);
}

export function encodePendingPlaintext(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    const end = Math.min(offset + 0x8000, bytes.length);
    const chars = new Array<string>(end - offset);
    for (let index = offset; index < end; index++) {
      chars[index - offset] = String.fromCharCode(bytes[index]!);
    }
    binary += chars.join('');
  }
  return btoa(binary);
}

export function decodePendingPlaintext(value: string): Uint8Array {
  try {
    return decodeBase64Bytes(value);
  } catch {
    throw new ArchiveContractError('pending_intent_corrupt');
  }
}

export async function assertPendingIntentAuthenticated(intent: {
  intentHash: string;
  commit?: LedgerCommit;
  expectedObjects?: PendingExpectedObject[];
  stateHash?: string;
  stateAuthentication?: string;
  key: CryptoKey;
  orgId: string;
  keyVersion: number;
}): Promise<void> {
  if (
    !intent.commit ||
    !intent.expectedObjects ||
    !intent.stateHash ||
    !intent.stateAuthentication
  ) {
    throw new ArchiveContractError('pending_intent_corrupt');
  }
  for (const object of intent.expectedObjects) {
    if (
      typeof object.key !== 'string' ||
      (object.objectClass !== 'chunk' && object.objectClass !== 'manifest') ||
      typeof object.plaintextBase64 !== 'string'
    ) {
      throw new ArchiveContractError('pending_intent_corrupt');
    }
    decodePendingPlaintext(object.plaintextBase64);
  }
  const expected = await pendingIntentStateHash(
    intent.intentHash,
    intent.commit,
    intent.expectedObjects,
  );
  if (expected !== intent.stateHash) {
    throw new ArchiveContractError('pending_intent_corrupt');
  }
  try {
    const authenticatedState = await decryptArchiveObject(
      JSON.parse(intent.stateAuthentication) as ArchiveObjectEnvelope,
      {
        key: intent.key,
        orgId: intent.orgId,
        objectKey: pendingIntentObjectKey(intent.intentHash),
        objectClass: 'manifest',
        keyVersion: intent.keyVersion,
      },
    );
    const decoded = JSON.parse(new TextDecoder().decode(authenticatedState)) as unknown;
    const expectedState = {
      intentHash: intent.intentHash,
      commit: intent.commit,
      expectedObjects: intent.expectedObjects,
    };
    if (JSON.stringify(decoded) !== JSON.stringify(expectedState)) {
      throw new Error('pending intent state mismatch');
    }
  } catch {
    throw new ArchiveContractError('pending_intent_corrupt');
  }
}
