import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createArchiveEncryptionKeyVersion,
  encryptArchiveObject,
  serializeArchiveWrappedKeyVersion,
  unwrapArchiveEncryptionKey,
} from '@trace-flow/utils';
import type { Logger } from '@trace-flow/logging';
import { executeArchiveExport, type ArchiveExportSelection } from '../archive-export';
import type { ArchiveApiEnv } from '../context';
import { MAX_CHUNK_BYTES, type ArchiveScope } from '../archive-contract';
import { archiveObjectKey } from '../archive-storage-key';
import type { ArchiveExportGrant } from '../export-grant';

const WRAPPING_SECRET = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const scope: ArchiveScope = {
  orgId: 'k57axc8sefsfp6k28nx6c481js806pwv',
  userId: 'j57axc8sefsfp6k28nx6c481js806pwv',
  contributionId: 'n57axc8sefsfp6k28nx6c481js806pwv',
  source: 'claude',
  sourceSessionId: 'session-1',
};
const grant: ArchiveExportGrant = {
  orgId: scope.orgId,
  exportId: 'export-1',
  actorUserId: scope.userId,
  issuedAt: 1,
  expiresAt: 2,
  targets: [
    {
      userId: scope.userId,
      contributionId: scope.contributionId,
      source: scope.source,
      sourceSessionId: scope.sourceSessionId,
    },
  ],
};

function logger(): Logger {
  return { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

async function digest(bytes: Uint8Array): Promise<string> {
  const hashed = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return `sha256:${Array.from(hashed, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function compress(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Response(bytes).body!.pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe('archive export', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('pins the exact committed ledger manifest and validates resume selection', async () => {
    const snapshot = {
      scope,
      keyVersion: 1,
      elementCount: 2,
      recordCount: 1,
      chainHead: `sha256:${'11'.repeat(32)}`,
      generation: 3,
      manifestKey: 'manifest-key',
      manifestHeadPageKey: 'manifest-head-key',
    };
    const stub = { exportSnapshot: vi.fn(async () => snapshot) };
    const env = {
      ARCHIVE_API_SHARED_SECRET: 'shared',
      ARCHIVE_SESSION_LEDGER: {
        idFromName: vi.fn(() => ({}) as DurableObjectId),
        get: vi.fn(() => stub),
      },
    } as unknown as ArchiveApiEnv;
    const selected = (await executeArchiveExport(
      env,
      grant,
      { operation: 'select' },
      logger(),
    )) as {
      selection: ArchiveExportSelection;
    };
    expect(selected.selection.sessions[0]).toMatchObject({
      manifestKey: snapshot.manifestKey,
      generation: 3,
      elementCount: 2,
    });
    await expect(
      executeArchiveExport(
        env,
        grant,
        { operation: 'select', selection: selected.selection },
        logger(),
      ),
    ).resolves.toEqual(selected);
    expect(stub.exportSnapshot).toHaveBeenCalledTimes(1);

    selected.selection.sessions[0]!.manifestKey = 'different';
    const { selectionSha256: _oldDigest, selectionToken: _token, ...unsigned } = selected.selection;
    selected.selection.selectionSha256 = await digest(
      new TextEncoder().encode(JSON.stringify(unsigned)),
    );
    await expect(
      executeArchiveExport(
        env,
        grant,
        { operation: 'select', selection: selected.selection },
        logger(),
      ),
    ).rejects.toThrow('archive_export_selection_invalid');
  });

  it('decrypts and verifies selected manifests and chunks', async () => {
    const keyVersion = await createArchiveEncryptionKeyVersion({
      orgId: scope.orgId,
      keyVersion: 1,
      wrappingSecretBase64: WRAPPING_SECRET,
    });
    const key = await unwrapArchiveEncryptionKey(keyVersion, {
      orgId: scope.orgId,
      keyVersion: 1,
      wrappingSecretBase64: WRAPPING_SECRET,
    });
    const chunkPlaintext = new TextEncoder().encode('{"kind":"record"}\n');
    const chunkDigest = await digest(chunkPlaintext);
    const chunkKey = await archiveObjectKey(scope, 'chunks', chunkDigest);
    const chunkEnvelope = await encryptArchiveObject(await compress(chunkPlaintext), {
      key,
      orgId: scope.orgId,
      objectKey: chunkKey,
      objectClass: 'chunk',
      keyVersion: 1,
    });
    const chainHead = `sha256:${'22'.repeat(32)}`;
    const manifestPlaintext = new TextEncoder().encode(
      JSON.stringify({
        archive_format_version: 1,
        chain_hash_version: 1,
        source: scope.source,
        source_session_id: scope.sourceSessionId,
        generation: 1,
        element_count: 1,
        chain_head: chainHead,
        elements: [],
      }),
    );
    const manifestDigest = await digest(manifestPlaintext);
    const manifestKey = await archiveObjectKey(scope, 'manifests', manifestDigest);
    const manifestEnvelope = await encryptArchiveObject(manifestPlaintext, {
      key,
      orgId: scope.orgId,
      objectKey: manifestKey,
      objectClass: 'manifest',
      keyVersion: 1,
    });
    const objects = new Map([
      [chunkKey, JSON.stringify(chunkEnvelope)],
      [manifestKey, JSON.stringify(manifestEnvelope)],
    ]);
    const env = {
      CONVEX_SITE_URL: 'https://convex.test',
      ARCHIVE_API_SHARED_SECRET: 'shared',
      ARCHIVE_KEY_WRAPPING_SECRET: WRAPPING_SECRET,
      ARCHIVE_STORAGE: {
        get: vi.fn(async (keyName: string) => {
          const value = objects.get(keyName);
          return value
            ? ({
                size: new TextEncoder().encode(value).byteLength,
                text: async () => value,
              } as R2ObjectBody)
            : null;
        }),
      },
      ARCHIVE_SESSION_LEDGER: {
        idFromName: vi.fn(() => ({}) as DurableObjectId),
        get: vi.fn(() => ({
          exportSnapshot: async () => ({
            scope,
            keyVersion: 1,
            elementCount: 1,
            recordCount: 1,
            chainHead,
            generation: 1,
            manifestKey,
            manifestHeadPageKey: manifestKey,
          }),
        })),
      },
    } as unknown as ArchiveApiEnv;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json({
        keyVersion: 1,
        wrappedKey: serializeArchiveWrappedKeyVersion(keyVersion),
      }),
    );
    const selected = (await executeArchiveExport(
      env,
      grant,
      { operation: 'select' },
      logger(),
    )) as {
      selection: ArchiveExportSelection;
    };
    await expect(
      executeArchiveExport(
        env,
        grant,
        {
          operation: 'manifest',
          selection: selected.selection,
          sessionIndex: 0,
          objectKey: manifestKey,
        },
        logger(),
      ),
    ).resolves.toMatchObject({ sha256: manifestDigest });
    await expect(
      executeArchiveExport(
        env,
        grant,
        {
          operation: 'chunk',
          selection: selected.selection,
          sessionIndex: 0,
          chunkId: chunkDigest.slice(7),
        },
        logger(),
      ),
    ).resolves.toMatchObject({ sha256: chunkDigest });

    const oversizedChunk = new Uint8Array(MAX_CHUNK_BYTES + 1);
    const oversizedDigest = await digest(oversizedChunk);
    const oversizedKey = await archiveObjectKey(scope, 'chunks', oversizedDigest);
    const oversizedEnvelope = await encryptArchiveObject(await compress(oversizedChunk), {
      key,
      orgId: scope.orgId,
      objectKey: oversizedKey,
      objectClass: 'chunk',
      keyVersion: 1,
    });
    objects.set(oversizedKey, JSON.stringify(oversizedEnvelope));
    await expect(
      executeArchiveExport(
        env,
        grant,
        {
          operation: 'chunk',
          selection: selected.selection,
          sessionIndex: 0,
          chunkId: oversizedDigest.slice(7),
        },
        logger(),
      ),
    ).rejects.toThrow('archive_export_object_too_large');
  });
});
