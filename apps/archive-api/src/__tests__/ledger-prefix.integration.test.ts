import { beforeEach, describe, expect, it } from 'vitest';
import {
  runInDurableObject,
  decryptArchiveObject,
  unwrapArchiveEncryptionKey,
  ARCHIVE_FORMAT_VERSION,
  CHAIN_HASH_VERSION,
  MAX_CHUNK_BYTES,
  validateObservation,
  archiveSessionPrefix,
  decompress,
  payloadBytes,
  prefixChainHash,
  claudeFixture,
  codexFixture,
  WRAPPING_SECRET,
  KEY_VERSION,
  runtimeEnv,
  partFor,
  base64,
  exactPrefix,
  digest,
  observation,
  checkpoint,
  archiveKey,
  fixtureUpload,
  scope,
  envelope,
  call,
  newLedger,
  ledgerEffects,
  expectIntegrity,
} from './ledger.integration.fixtures';
import type { StoredElement } from './ledger.integration.fixtures';

describe('Archive Session Ledger', () => {
  beforeEach(() => {
    expect(runtimeEnv.ARCHIVE_KEY_WRAPPING_SECRET).toBe(WRAPPING_SECRET);
  });

  it('stores a server-owned record wrapper when observations contain conflicting fields', async () => {
    const currentScope = scope('codex', `server-fields-${crypto.randomUUID()}`);
    const record = await observation(
      'codex',
      currentScope.sourceSessionId,
      partFor('codex'),
      '0',
      '"record"',
    );
    const poisoned = { ...record, kind: 'checkpoint', chain_hash: 'client-supplied' };
    const upload = {
      source_session_id: currentScope.sourceSessionId,
      observations: [poisoned],
      checkpoint: await checkpoint('codex', currentScope.sourceSessionId, partFor('codex'), [
        record,
      ]),
      complete_prefix_base64: base64(exactPrefix([poisoned])),
    };
    const result = await call(newLedger(currentScope), await envelope(currentScope, upload));
    expect(result.response.status).toBe(200);
    const stored = await runInDurableObject(newLedger(currentScope), (_instance, state) => [
      ...state.storage.sql.exec<{ data: string }>('SELECT data FROM ledger_elements'),
    ]);
    const element = JSON.parse(stored[0]!.data) as Record<string, unknown>;
    expect(element.kind).toBe('record');
    expect(element.chain_hash).not.toBe('client-supplied');
    expect(element).not.toHaveProperty('payload');
  });

  it('rejects missing, shortened, and historically changed prefixes without advancing', async () => {
    const currentScope = scope('codex', `prefix-${crypto.randomUUID()}`);
    const firstRecord = await observation(
      'codex',
      currentScope.sourceSessionId,
      partFor('codex'),
      '0',
      '"zero"',
    );
    const firstCheckpoint = await checkpoint(
      'codex',
      currentScope.sourceSessionId,
      partFor('codex'),
      [firstRecord],
    );
    const stub = newLedger(currentScope);
    const initial = await call(
      stub,
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: [firstRecord],
        checkpoint: firstCheckpoint,
        complete_prefix_base64: base64(exactPrefix([firstRecord])),
      }),
    );
    const shortened = await checkpoint('codex', currentScope.sourceSessionId, partFor('codex'), []);
    const missingProof = await call(
      stub,
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: [],
        checkpoint: shortened,
      }),
    );
    expectIntegrity(missingProof, 'missing_historical_prefix_proof');

    const changedRecord = await observation(
      'codex',
      currentScope.sourceSessionId,
      partFor('codex'),
      '0',
      '"changed"',
    );
    const changed = await checkpoint('codex', currentScope.sourceSessionId, partFor('codex'), [
      changedRecord,
    ]);
    const historicalChange = await call(
      stub,
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: [changedRecord],
        checkpoint: changed,
        prior_checkpoint: firstCheckpoint,
        complete_prefix_base64: base64(exactPrefix([changedRecord])),
      }),
    );
    expectIntegrity(historicalChange, 'missing_historical_prefix_proof');

    const state = await runInDurableObject(
      stub,
      (_instance, state) =>
        [
          ...state.storage.sql.exec<{ data: string }>('SELECT data FROM ledger_state WHERE id = 1'),
        ][0],
    );
    if (!state) throw new Error('ledger state row missing');
    const stored = JSON.parse(state.data) as { generation: number };
    expect(stored.generation).toBe(initial.body.generation);
  });

  it('rejects a same-position checkpoint after the source file shrinks', async () => {
    const currentScope = scope('codex', `shortened-same-position-${crypto.randomUUID()}`);
    const record = await observation(
      'codex',
      currentScope.sourceSessionId,
      partFor('codex'),
      '0',
      '"zero"',
    );
    const originalCheckpoint = await checkpoint(
      'codex',
      currentScope.sourceSessionId,
      partFor('codex'),
      [record],
    );
    const largerFileCheckpoint = {
      ...originalCheckpoint,
      observed_file_size: originalCheckpoint.observed_file_size + 10,
    };
    const stub = newLedger(currentScope);
    const initial = await call(
      stub,
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: [record],
        checkpoint: largerFileCheckpoint,
        complete_prefix_base64: base64(exactPrefix([record])),
      }),
    );
    expect(initial.response.status).toBe(200);

    const shortened = await call(
      stub,
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: [record],
        checkpoint: originalCheckpoint,
        complete_prefix_base64: base64(exactPrefix([record])),
      }),
    );
    expectIntegrity(shortened, 'checkpoint_regressed');
  });

  it.each(['claude', 'codex'] as const)(
    'rejects an advancing %s delta after the source file shrinks',
    async (source) => {
      const currentScope = scope(source, `shortened-advancing-${crypto.randomUUID()}`);
      const part = partFor(source);
      const firstRecord = await observation(
        source,
        currentScope.sourceSessionId,
        part,
        'r1',
        '"first"',
      );
      const firstCheckpoint = await checkpoint(
        source,
        currentScope.sourceSessionId,
        part,
        [firstRecord],
        100,
      );
      const stub = newLedger(currentScope);
      const initial = await call(
        stub,
        await envelope(currentScope, {
          source_session_id: currentScope.sourceSessionId,
          observations: [firstRecord],
          checkpoint: firstCheckpoint,
          complete_prefix_base64: base64(exactPrefix([firstRecord])),
        }),
      );
      expect(initial.response.status).toBe(200);

      const before = await runInDurableObject(stub, (_instance, durableState) => ({
        ledger: [
          ...durableState.storage.sql.exec<{ data: string }>(
            'SELECT data FROM ledger_state WHERE id = 1',
          ),
        ],
        intents: [
          ...durableState.storage.sql.exec<{
            intent_hash: string;
            status: string;
            base_element_count: number;
            base_chain_head: string;
          }>(
            'SELECT intent_hash, status, base_element_count, base_chain_head FROM pending_intents ORDER BY intent_hash',
          ),
        ],
        metadata: [
          ...durableState.storage.sql.exec<{
            intent_hash: string;
            part_index: number;
            data: string;
          }>(
            'SELECT intent_hash, part_index, data FROM pending_intent_metadata ORDER BY intent_hash, part_index',
          ),
        ],
      }));
      const beforeObjects = (
        await runtimeEnv.ARCHIVE_STORAGE.list({
          prefix: await archiveSessionPrefix(currentScope),
        })
      ).objects.map(({ key, size }) => ({ key, size }));

      const appendRecord = await observation(
        source,
        currentScope.sourceSessionId,
        part,
        'r2',
        '"second"',
      );
      const appendedBytes = new TextEncoder().encode(`${appendRecord.payload}\n`);
      const nextUploadCheckpoint = {
        ...(await checkpoint(
          source,
          currentScope.sourceSessionId,
          part,
          [firstRecord, appendRecord],
          exactPrefix([firstRecord]).byteLength + appendedBytes.byteLength,
        )),
        prefix_chain_sha256: await prefixChainHash(
          firstCheckpoint.prefix_chain_sha256,
          appendedBytes,
        ),
      };
      const priorCheckpoint = {
        ...firstCheckpoint,
        observed_file_size: firstCheckpoint.last_complete_byte_offset,
      };
      const shortened = await call(
        stub,
        await envelope(currentScope, {
          source_session_id: currentScope.sourceSessionId,
          observations: [appendRecord],
          checkpoint: nextUploadCheckpoint,
          prior_checkpoint: priorCheckpoint,
          append_proof: {
            prior_prefix_chain_sha256: firstCheckpoint.prefix_chain_sha256,
            appended_prefix_base64: base64(appendedBytes),
          },
        }),
      );
      expectIntegrity(shortened, 'checkpoint_regressed');

      const after = await runInDurableObject(stub, (_instance, durableState) => ({
        ledger: [
          ...durableState.storage.sql.exec<{ data: string }>(
            'SELECT data FROM ledger_state WHERE id = 1',
          ),
        ],
        intents: [
          ...durableState.storage.sql.exec<{
            intent_hash: string;
            status: string;
            base_element_count: number;
            base_chain_head: string;
          }>(
            'SELECT intent_hash, status, base_element_count, base_chain_head FROM pending_intents ORDER BY intent_hash',
          ),
        ],
        metadata: [
          ...durableState.storage.sql.exec<{
            intent_hash: string;
            part_index: number;
            data: string;
          }>(
            'SELECT intent_hash, part_index, data FROM pending_intent_metadata ORDER BY intent_hash, part_index',
          ),
        ],
      }));
      const afterObjects = (
        await runtimeEnv.ARCHIVE_STORAGE.list({
          prefix: await archiveSessionPrefix(currentScope),
        })
      ).objects.map(({ key, size }) => ({ key, size }));
      expect(after).toEqual(before);
      expect(afterObjects).toEqual(beforeObjects);
    },
  );

  it.each(['claude', 'codex'] as const)(
    'rejects an advancing %s full rescan after the source file shrinks',
    async (source) => {
      const currentScope = scope(source, `shortened-full-rescan-${crypto.randomUUID()}`);
      const part = partFor(source);
      const firstRecord = await observation(
        source,
        currentScope.sourceSessionId,
        part,
        'r1',
        '"first"',
      );
      const partialSource = new TextEncoder().encode(
        `${firstRecord.payload}\n${'partial tail '.repeat(12)}`,
      );
      const firstCheckpoint = await checkpoint(
        source,
        currentScope.sourceSessionId,
        part,
        [firstRecord],
        partialSource.byteLength,
      );
      const stub = newLedger(currentScope);
      const initial = await call(
        stub,
        await envelope(currentScope, {
          source_session_id: currentScope.sourceSessionId,
          observations: [firstRecord],
          checkpoint: firstCheckpoint,
          complete_prefix_base64: base64(exactPrefix([firstRecord])),
        }),
      );
      expect(initial.response.status).toBe(200);
      const before = await ledgerEffects(stub, currentScope);

      const secondRecord = await observation(
        source,
        currentScope.sourceSessionId,
        part,
        'r2',
        '"second"',
      );
      const fullPrefix = exactPrefix([firstRecord, secondRecord]);
      const fullCheckpoint = await checkpoint(
        source,
        currentScope.sourceSessionId,
        part,
        [firstRecord, secondRecord],
        fullPrefix.byteLength,
      );
      expect(fullCheckpoint.last_complete_byte_offset).toBe(fullPrefix.byteLength);
      expect(fullCheckpoint.last_complete_byte_offset).toBeGreaterThan(
        firstCheckpoint.last_complete_byte_offset,
      );
      expect(fullCheckpoint.observed_file_size).toBeLessThan(firstCheckpoint.observed_file_size);

      const rejected = await call(
        stub,
        await envelope(currentScope, {
          source_session_id: currentScope.sourceSessionId,
          observations: [firstRecord, secondRecord],
          checkpoint: fullCheckpoint,
          complete_prefix_base64: base64(fullPrefix),
        }),
      );
      expectIntegrity(rejected, 'checkpoint_regressed');

      const after = await ledgerEffects(stub, currentScope);
      expect(after).toEqual(before);
    },
  );

  it('rejects a historically changed Source prefix without advancing', async () => {
    const currentScope = scope('codex', `historical-${crypto.randomUUID()}`);
    const firstRecord = await observation(
      'codex',
      currentScope.sourceSessionId,
      partFor('codex'),
      '0',
      '"zero"',
    );
    const firstCheckpoint = await checkpoint(
      'codex',
      currentScope.sourceSessionId,
      partFor('codex'),
      [firstRecord],
    );
    const stub = newLedger(currentScope);
    const initial = await call(
      stub,
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: [firstRecord],
        checkpoint: firstCheckpoint,
        complete_prefix_base64: base64(exactPrefix([firstRecord])),
      }),
    );
    expect(initial.response.status).toBe(200);

    const changedRecord = await observation(
      'codex',
      currentScope.sourceSessionId,
      partFor('codex'),
      '0',
      '"changed"',
    );
    const changed = await call(
      stub,
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: [changedRecord],
        checkpoint: await checkpoint('codex', currentScope.sourceSessionId, partFor('codex'), [
          changedRecord,
        ]),
        prior_checkpoint: firstCheckpoint,
        complete_prefix_base64: base64(exactPrefix([changedRecord])),
      }),
    );
    expectIntegrity(changed, 'historical_prefix_changed');
  });

  it.each([
    ['claude', claudeFixture],
    ['codex', codexFixture],
  ] as const)('round-trips the lossless %s source fixture', async (source, fixture) => {
    const currentScope = scope(source, `fixture-${crypto.randomUUID()}`);
    const upload = await fixtureUpload(source, currentScope.sourceSessionId, fixture);
    const result = await call(newLedger(currentScope), await envelope(currentScope, upload));
    expect(result.response.status).toBe(200);

    const wrapped = await archiveKey(currentScope.orgId);
    const key = await unwrapArchiveEncryptionKey(JSON.parse(wrapped), {
      orgId: currentScope.orgId,
      keyVersion: KEY_VERSION,
      wrappingSecretBase64: WRAPPING_SECRET,
    });
    const manifestObject = await runtimeEnv.ARCHIVE_STORAGE.get(result.body.manifest_key as string);
    const manifest = JSON.parse(
      new TextDecoder().decode(
        await decryptArchiveObject(JSON.parse(await manifestObject!.text()), {
          key,
          orgId: currentScope.orgId,
          objectKey: result.body.manifest_key as string,
          objectClass: 'manifest',
          keyVersion: KEY_VERSION,
        }),
      ),
    ) as { elements: { byte_range: { chunk_id: string; start: number; end: number } }[] };
    const plaintextChunks = new Map<string, Uint8Array>();
    const payload = [] as Uint8Array[];
    for (const element of manifest.elements) {
      const range = element.byte_range;
      let chunk = plaintextChunks.get(range.chunk_id);
      if (!chunk) {
        const chunkKey = `${await archiveSessionPrefix(currentScope)}/chunks/${range.chunk_id}`;
        const chunkObject = await runtimeEnv.ARCHIVE_STORAGE.get(chunkKey);
        const compressed = await decryptArchiveObject(JSON.parse(await chunkObject!.text()), {
          key,
          orgId: currentScope.orgId,
          objectKey: chunkKey,
          objectClass: 'chunk',
          keyVersion: KEY_VERSION,
        });
        chunk = await decompress(compressed);
        plaintextChunks.set(range.chunk_id, chunk);
      }
      const parsed = JSON.parse(
        new TextDecoder().decode(chunk.slice(range.start, range.end - 1)),
      ) as StoredElement;
      if (parsed.kind === 'record') {
        payload.push(payloadBytes(parsed), new Uint8Array([0x0a]));
      }
    }
    const reconstructed = new Uint8Array(payload.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of payload) {
      reconstructed.set(part, offset);
      offset += part.length;
    }
    expect(reconstructed).toEqual(new TextEncoder().encode(fixture));
  });

  it('uses exact source-prefix bytes to reject changed historical whitespace', async () => {
    const currentScope = scope('claude', `prefix-bytes-${crypto.randomUUID()}`);
    const record = await observation(
      'claude',
      currentScope.sourceSessionId,
      partFor('claude'),
      'claude:part:parent:claude:id:r1:0',
      '{"uuid":"r1"}',
    );
    const originalPrefix = new TextEncoder().encode('\n \n{"uuid":"r1"}\n');
    const originalCheckpoint = await checkpoint(
      'claude',
      currentScope.sourceSessionId,
      partFor('claude'),
      [record],
      originalPrefix.byteLength,
    );
    originalCheckpoint.last_complete_byte_offset = originalPrefix.byteLength;
    originalCheckpoint.complete_prefix_sha256 = await digest(originalPrefix);
    originalCheckpoint.prefix_chain_sha256 = await prefixChainHash(undefined, originalPrefix);
    const stub = newLedger(currentScope);
    const initial = await call(
      stub,
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: [record],
        checkpoint: originalCheckpoint,
        complete_prefix_base64: base64(originalPrefix),
      }),
    );
    expect(initial.response.status).toBe(200);

    const mismatchedRecord = await observation(
      'claude',
      currentScope.sourceSessionId,
      partFor('claude'),
      'claude:part:parent:claude:id:r1:0',
      '{"uuid":"r1","changed":true}',
    );
    const mismatched = await call(
      stub,
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: [mismatchedRecord],
        checkpoint: originalCheckpoint,
        complete_prefix_base64: base64(originalPrefix),
      }),
    );
    expectIntegrity(mismatched, 'checkpoint_prefix_unverifiable');

    const changedPrefix = new TextEncoder().encode('\n\t\n{"uuid":"r1"}\n');
    const changedCheckpoint = {
      ...originalCheckpoint,
      last_complete_byte_offset: changedPrefix.byteLength,
      complete_prefix_sha256: await digest(changedPrefix),
      prefix_chain_sha256: await prefixChainHash(undefined, changedPrefix),
    };
    const rejected = await call(
      stub,
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: [record],
        checkpoint: changedCheckpoint,
        prior_checkpoint: originalCheckpoint,
        complete_prefix_base64: base64(changedPrefix),
      }),
    );
    expectIntegrity(rejected, 'checkpoint_prefix_unverifiable');
  });

  it('validates large binary base64 payloads and rejects noncanonical UTF-8 base64', async () => {
    const currentScope = scope('codex', `encoding-${crypto.randomUUID()}`);
    const binary = new Uint8Array(MAX_CHUNK_BYTES);
    binary[0] = 0xff;
    binary[1] = 0;
    binary[binary.length - 1] = 0xfe;
    const binaryRecord = {
      archive_format_version: ARCHIVE_FORMAT_VERSION,
      chain_hash_version: CHAIN_HASH_VERSION,
      source: 'codex' as const,
      source_session_id: currentScope.sourceSessionId,
      source_transcript_part_id: partFor('codex'),
      source_record_identity: 'codex:part:primary:codex:line:0',
      observed_at: 1,
      payload_encoding: 'base64' as const,
      payload: base64(binary),
      content_sha256: await digest(binary),
    };
    await expect(
      validateObservation(binaryRecord, {
        source: 'codex',
        sourceSessionId: currentScope.sourceSessionId,
      }),
    ).resolves.toEqual(binaryRecord);

    const utf8 = new TextEncoder().encode('valid utf8');
    await expect(
      validateObservation(
        { ...binaryRecord, payload: base64(utf8), content_sha256: await digest(utf8) },
        { source: 'codex', sourceSessionId: currentScope.sourceSessionId },
      ),
    ).rejects.toMatchObject({ errorClass: 'noncanonical_payload_encoding' });
  });
});
