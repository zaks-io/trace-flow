import { describe, expect, it } from 'bun:test';
import { rejects } from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { GENESIS_CHAIN_HASH } from '../../apps/archive-api/src/archive-contract';
import { collectExportManifestGraph } from './archive-export-traversal';
import {
  exportSessionDirectoryId,
  latestSidecarGenerations,
  RawPartVerifier,
} from './archive-export-verification';

const digest = (hex: string) => `sha256:${hex.repeat(64)}`;

describe('archive export client verification', () => {
  it('restores the latest sidecar generation and retains older part files', () => {
    expect(
      latestSidecarGenerations([
        {
          relativePath: 'tool-results/result.txt',
          file: 'parts/older.bin',
          firstObservedAt: 10,
          checkpointSequence: 8,
        },
        {
          relativePath: 'tool-results/result.txt',
          file: 'parts/latest.bin',
          firstObservedAt: 11,
          checkpointSequence: 3,
        },
        {
          relativePath: 'tool-results/other.txt',
          file: 'parts/other.bin',
          firstObservedAt: 9,
          checkpointSequence: 5,
        },
      ]),
    ).toEqual([
      { relativePath: 'tool-results/result.txt', file: 'parts/latest.bin' },
      { relativePath: 'tool-results/other.txt', file: 'parts/other.bin' },
    ]);
  });

  it('does not mark a session verified when its declared record count is wrong', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'archive-record-count-'));
    const unsigned = {
      version: 1,
      exportId: 'record-count-test',
      orgId: 'org-test',
      sessions: [
        {
          userId: 'user-test',
          contributionId: 'contribution-test',
          source: 'codex',
          sourceSessionId: 'session-test',
          manifestKey: 'manifest-test',
          manifestHeadPageKey: 'page-test',
          generation: 1,
          elementCount: 0,
          recordCount: 1,
          chainHead: GENESIS_CHAIN_HASH,
        },
      ],
    };
    const selection = {
      ...unsigned,
      selectionSha256: `sha256:${createHash('sha256').update(JSON.stringify(unsigned)).digest('hex')}`,
      selectionToken: 'a'.repeat(43),
    };
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as { operation: string };
        return Response.json(
          body.operation === 'select' ? { selection } : { manifest: { elements: [] } },
        );
      },
    });
    try {
      const child = Bun.spawn(
        [
          process.execPath,
          resolve(import.meta.dir, 'archive-export.ts'),
          server.url.href,
          directory,
        ],
        { env: { TRACE_FLOW_ARCHIVE_EXPORT_GRANT: 'test-grant' }, stdout: 'pipe', stderr: 'pipe' },
      );
      const [exit, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
        new Response(child.stdout).text(),
      ]);
      expect(exit).not.toBe(0);
      expect(stderr).toContain('Manifest record count mismatch');
      const manifest = JSON.parse(
        await readFile(resolve(directory, 'archive-manifest.json'), 'utf8'),
      ) as { sessions: { status: string }[] };
      expect(manifest.sessions[0]?.status).toBe('failed');
    } finally {
      await server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('refetches the manifest graph after an interrupted traversal', async () => {
    const graph = new Map([
      ['root', { pages: [{ page_key: 'first' }, { page_key: 'second' }] }],
      ['first', { elements: ['a'] }],
      ['second', { elements: ['b'] }],
    ]);
    let fail = true;
    const load = async (key: string) => {
      if (key === 'first' && fail) {
        fail = false;
        throw new Error('interrupted');
      }
      return graph.get(key)!;
    };
    await rejects(
      collectExportManifestGraph('root', load, () => undefined),
      /interrupted/,
    );
    const restored: string[] = [];
    await collectExportManifestGraph('root', load, (elements) => restored.push(...elements));
    expect(restored.sort()).toEqual(['a', 'b']);
  });

  it('rejects wrong offsets, missing segments, and a checkpoint over a gap', () => {
    const verifier = new RawPartVerifier();
    verifier.addSegment({
      identity: 'bytes:0:3',
      manifestStart: 0,
      manifestEnd: 3,
      bytes: new TextEncoder().encode('abc'),
    });
    expect(() =>
      verifier.addSegment({
        identity: 'bytes:4:6',
        manifestStart: 4,
        manifestEnd: 6,
        bytes: new TextEncoder().encode('de'),
      }),
    ).toThrow('Archive byte segment gap or overlap');
    expect(() => verifier.assertComplete()).toThrow('no verified completed checkpoint');
    expect(() =>
      verifier.verifyCheckpoint({
        archive_format_version: 2,
        chain_hash_version: 1,
        source: 'codex',
        source_session_id: 'session-1',
        source_transcript_part_id: 'codex:part:primary',
        record_count: 2,
        last_source_record_identity: 'bytes:4:6',
        last_complete_byte_offset: 6,
        observed_file_size: 6,
        complete_prefix_sha256: digest('0'),
        prefix_chain_sha256: digest('1'),
        first_observed_at: 1,
      }),
    ).toThrow();
  });

  it('verifies an exact format 2 part and its predecessor lineage', () => {
    const verifier = new RawPartVerifier();
    verifier.addSegment({
      identity: 'bytes:0:3:from:codex:part:primary',
      manifestStart: 0,
      manifestEnd: 3,
      manifestPredecessorPartId: 'codex:part:primary',
      bytes: new TextEncoder().encode('abc'),
    });
    verifier.addSegment({
      identity: 'bytes:3:5:from:codex:part:primary',
      manifestStart: 3,
      manifestEnd: 5,
      manifestPredecessorPartId: 'codex:part:primary',
      bytes: new TextEncoder().encode('de'),
    });
    verifier.verifyCheckpoint({
      archive_format_version: 2,
      chain_hash_version: 1,
      source: 'codex',
      source_session_id: 'session-1',
      source_transcript_part_id: `codex:part:sha256:${'a'.repeat(64)}`,
      record_count: 2,
      last_source_record_identity: 'bytes:3:5:from:codex:part:primary',
      last_complete_byte_offset: 5,
      observed_file_size: 5,
      complete_prefix_sha256: verifier.sha256(),
      prefix_chain_sha256: digest('1'),
      first_observed_at: 1,
    });
    expect(() => verifier.assertComplete()).not.toThrow();
    expect(verifier.predecessorPartId).toBe('codex:part:primary');
    expect(verifier.observedSourceSize).toBe(5);
    expect(verifier.sourceCaptureComplete).toBe(true);
  });

  it('reports a verified captured prefix without claiming the source suffix was captured', () => {
    const verifier = new RawPartVerifier();
    verifier.addSegment({
      identity: 'bytes:0:3',
      manifestStart: 0,
      manifestEnd: 3,
      bytes: new TextEncoder().encode('abc'),
    });
    verifier.verifyCheckpoint({
      archive_format_version: 2,
      chain_hash_version: 1,
      source: 'claude',
      source_session_id: 'session-partial',
      source_transcript_part_id: 'claude:part:primary',
      record_count: 1,
      last_source_record_identity: 'bytes:0:3',
      last_complete_byte_offset: 3,
      observed_file_size: 5,
      complete_prefix_sha256: verifier.sha256(),
      prefix_chain_sha256: digest('0'),
      first_observed_at: 1,
    });
    expect(() => verifier.assertComplete()).not.toThrow();
    expect(verifier.observedSourceSize).toBe(5);
    expect(verifier.sourceCaptureComplete).toBe(false);
  });

  it('verifies an empty exact format 2 part', () => {
    const verifier = new RawPartVerifier();
    verifier.verifyCheckpoint({
      archive_format_version: 2,
      chain_hash_version: 1,
      source: 'claude',
      source_session_id: 'session-empty',
      source_transcript_part_id: 'claude:part:primary',
      record_count: 0,
      last_source_record_identity: null,
      last_complete_byte_offset: 0,
      observed_file_size: 0,
      complete_prefix_sha256: verifier.sha256(),
      prefix_chain_sha256: digest('0'),
      first_observed_at: 1,
    });
    expect(() => verifier.assertComplete()).not.toThrow();
  });

  it('rejects a predecessor lineage change within one part', () => {
    const verifier = new RawPartVerifier();
    verifier.addSegment({
      identity: 'bytes:0:1',
      manifestStart: 0,
      manifestEnd: 1,
      bytes: new Uint8Array([1]),
    });
    expect(() =>
      verifier.addSegment({
        identity: 'bytes:1:2:from:codex:part:primary',
        manifestStart: 1,
        manifestEnd: 2,
        manifestPredecessorPartId: 'codex:part:primary',
        bytes: new Uint8Array([2]),
      }),
    ).toThrow();
  });

  it('uses contribution scope when two contributions share a source session id', async () => {
    const [left, right] = await Promise.all([
      exportSessionDirectoryId('contribution-a', 'session-1'),
      exportSessionDirectoryId('contribution-b', 'session-1'),
    ]);
    expect(left).not.toBe(right);
  });
});
