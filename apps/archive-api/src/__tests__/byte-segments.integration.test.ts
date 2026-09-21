import { describe, expect, it } from 'vitest';
import fixture from '../../../../packages/collector-archive/tests/fixtures/archive-byte-session.json';
import { parseAndValidateUpload } from '../archive-validation';
import { buildRecord, checkpointChainHash } from '../archive-chain';
import { assertByteSegments, byteSegmentRange } from '../archive-byte-segments';
import { GENESIS_CHAIN_HASH, type ArchiveUploadRequest } from '../archive-contract';
import { payloadBytes } from '../archive-contract';
import { validateObservation } from '../archive-contract-validation';
import { prefixChainHash } from '../archive-prefix-validation';
import { call, envelope, newLedger, scope, digest } from './ledger.integration.fixtures';

describe('exact source byte segments', () => {
  it('commits an empty generation and then its first byte append', async () => {
    const currentScope = scope('codex', 'empty-byte-fixture');
    const stub = newLedger(currentScope);
    const emptyCheckpoint = {
      ...fixture.upload.checkpoint,
      source_session_id: currentScope.sourceSessionId,
      source: 'codex' as const,
      record_count: 0,
      last_source_record_identity: null,
      last_complete_byte_offset: 0,
      observed_file_size: 0,
      complete_prefix_sha256: await digest(new Uint8Array()),
      prefix_chain_sha256: await prefixChainHash(undefined, new Uint8Array()),
    };
    const empty: ArchiveUploadRequest = {
      source_session_id: currentScope.sourceSessionId,
      observations: [],
      checkpoint: emptyCheckpoint,
      complete_prefix_base64: '',
    };
    const first = await call(stub, await envelope(currentScope, empty));
    expect(first.response.status).toBe(200);
    expect(first.body.appended_checkpoint).toBe(true);
    const bytes = Uint8Array.from(atob(fixture.source_base64), (char) => char.charCodeAt(0));
    const identity = `${fixture.upload.observations[0]!.source_record_identity}:from:codex:part:sha256:${'b'.repeat(64)}`;
    const append: ArchiveUploadRequest = {
      source_session_id: currentScope.sourceSessionId,
      observations: [
        {
          ...fixture.upload.observations[0]!,
          source_session_id: currentScope.sourceSessionId,
          source: 'codex',
          payload_encoding: 'base64',
          source_record_identity: identity,
        },
      ],
      checkpoint: {
        ...fixture.upload.checkpoint,
        source_session_id: currentScope.sourceSessionId,
        source: 'codex',
        last_source_record_identity: identity,
        prefix_chain_sha256: await prefixChainHash(emptyCheckpoint.prefix_chain_sha256, bytes),
      },
      prior_checkpoint: emptyCheckpoint,
      append_proof: {
        prior_prefix_chain_sha256: emptyCheckpoint.prefix_chain_sha256,
        appended_prefix_base64: fixture.source_base64,
      },
    };
    const second = await call(stub, await envelope(currentScope, append));
    expect(second.response.status).toBe(200);
    expect(second.body.record_count).toBe(1);
  });
  it('preserves a UTF-8 BOM as source bytes', async () => {
    const payload = '\ufeff{unfinished';
    const bytes = new TextEncoder().encode(payload);
    const observation = await validateObservation(
      {
        ...fixture.upload.observations[0],
        source_record_identity: `bytes:0:${bytes.length}`,
        payload_encoding: 'utf8',
        payload,
        content_sha256: await digest(bytes),
      },
      { source: 'codex', sourceSessionId: fixture.upload.source_session_id },
    );
    expect(payloadBytes(observation)).toEqual(bytes);
  });
  it('agrees with the independent Rust fixture and commits malformed partial bytes', async () => {
    const currentScope = scope('codex', fixture.upload.source_session_id);
    const validated = await parseAndValidateUpload(fixture.upload, currentScope);
    const record = await buildRecord(validated.observations[0]!, 0, GENESIS_CHAIN_HASH);
    expect(record.chain_hash).toBe(fixture.record_chain_hash);
    expect(await checkpointChainHash(record.chain_hash, 1, validated.checkpoint)).toBe(
      fixture.checkpoint_chain_hash,
    );
    const stub = newLedger(currentScope);
    const requestSha256 = await digest(new TextEncoder().encode(JSON.stringify(fixture.upload)));
    const input = {
      ...(await envelope(currentScope, fixture.upload as ArchiveUploadRequest)),
      requestSha256,
    };
    const first = await call(stub, input);
    expect(first.response.status).toBe(200);
    expect(first.body).toMatchObject({
      request_sha256: requestSha256,
      source_transcript_part_id: 'codex:part:primary',
      captured_byte_offset: fixture.upload.checkpoint.last_complete_byte_offset,
      captured_prefix_sha256: fixture.upload.checkpoint.complete_prefix_sha256,
      chain_head: fixture.checkpoint_chain_hash,
    });
    const retry = await call(stub, input);
    expect(retry.body).toEqual(first.body);
    const snapshot = await stub.exportSnapshot({ scope: currentScope });
    expect(snapshot?.manifestKey).toBe(first.body.manifest_key);
  });

  it('rejects discontinuous offsets and mixed formats', async () => {
    const currentScope = scope('codex', fixture.upload.source_session_id);
    const gap = structuredClone(fixture.upload);
    gap.observations[0]!.source_record_identity = 'bytes:1:15';
    await expect(parseAndValidateUpload(gap, currentScope)).rejects.toThrow();
    const mixed = structuredClone(fixture.upload);
    mixed.observations[0]!.archive_format_version = 1;
    await expect(parseAndValidateUpload(mixed, currentScope)).rejects.toThrow(
      'checkpoint_part_mismatch',
    );
    for (const identity of [
      'bytes:00:1',
      'bytes:0:0',
      'bytes:0:524289',
      'bytes:0:9007199254740992',
    ]) {
      expect(() => byteSegmentRange(identity)).toThrow();
    }
  });

  it('rejects predecessor lineage changes inside an initial upload', () => {
    const prefix = new TextEncoder().encode('ab');
    const first = {
      ...fixture.upload.observations[0]!,
      source: 'codex' as const,
      source_record_identity: `bytes:0:1:from:codex:part:sha256:${'a'.repeat(64)}`,
      payload_encoding: 'utf8' as const,
      payload: 'a',
    };
    const second = {
      ...fixture.upload.observations[0]!,
      source: 'codex' as const,
      source_record_identity: 'bytes:1:2',
      payload_encoding: 'utf8' as const,
      payload: 'b',
    };
    expect(() => assertByteSegments([first, second], prefix, 0)).toThrow(
      'generation_predecessor_changed',
    );
  });
});
