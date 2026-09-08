import type { Logger } from '@trace-flow/logging';
import {
  decryptArchiveObject,
  parseArchiveWrappedKeyVersion,
  unwrapArchiveEncryptionKey,
  type ArchiveObjectEnvelope,
} from '@trace-flow/utils';
import type { ArchiveApiEnv } from './context';
import { ArchiveContractError } from './archive-contract';
import { getArchiveWrappedKeyVersion } from './archive-key-client';
import { MAX_ENCRYPTED_ARCHIVE_OBJECT_BYTES } from './archive-key-reencryption';

export type LegacyKeyProvenanceEnv = Pick<
  ArchiveApiEnv,
  | 'ARCHIVE_STORAGE'
  | 'CONVEX_SITE_URL'
  | 'ARCHIVE_API_SHARED_SECRET'
  | 'ARCHIVE_KEY_WRAPPING_SECRET'
>;

function envelopeKeyVersion(body: string): number {
  try {
    const envelope = JSON.parse(body) as { keyVersion?: unknown };
    if (!Number.isSafeInteger(envelope.keyVersion) || (envelope.keyVersion as number) < 1) {
      throw new Error('invalid_key_version');
    }
    return envelope.keyVersion as number;
  } catch {
    throw new ArchiveContractError('archive_key_version_unknown');
  }
}

export async function recoverLegacyArchiveKeyVersion(
  object: R2Object,
  objectClass: 'chunk' | 'manifest',
  orgId: string,
  env: LegacyKeyProvenanceEnv,
  logger: Logger,
  keys: Map<number, Promise<CryptoKey>>,
): Promise<number> {
  try {
    if (object.size > MAX_ENCRYPTED_ARCHIVE_OBJECT_BYTES) {
      throw new Error('archive_object_too_large');
    }
    const stored = await env.ARCHIVE_STORAGE.get(object.key);
    if (stored?.size !== object.size) throw new Error('archive_object_changed');
    const body = await stored.text();
    const keyVersion = envelopeKeyVersion(body);
    let key = keys.get(keyVersion);
    if (!key) {
      key = getArchiveWrappedKeyVersion(env, { orgId, keyVersion }, logger).then((wrapped) =>
        unwrapArchiveEncryptionKey(
          parseArchiveWrappedKeyVersion(wrapped.wrappedKey, { orgId, keyVersion }),
          {
            orgId,
            keyVersion,
            wrappingSecretBase64: env.ARCHIVE_KEY_WRAPPING_SECRET,
          },
        ),
      );
      keys.set(keyVersion, key);
    }
    const plaintext = await decryptArchiveObject(JSON.parse(body) as ArchiveObjectEnvelope, {
      key: await key,
      orgId,
      objectKey: object.key,
      objectClass,
      keyVersion,
    });
    plaintext.fill(0);
    return keyVersion;
  } catch {
    throw new ArchiveContractError('archive_key_version_unknown');
  }
}
