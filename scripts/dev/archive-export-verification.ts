import { strict as assert } from 'node:assert';
import { createHash, type Hash } from 'node:crypto';
import type { CompletedScanCheckpoint } from '../../apps/archive-api/src/archive-contract';

export interface SourceByteRange {
  start: number;
  end: number;
  predecessorPartId?: string;
}

export function sourceByteRange(identity: string): SourceByteRange {
  const match = /^bytes:(0|[1-9][0-9]*):(0|[1-9][0-9]*)(?::from:(.+))?$/u.exec(identity);
  assert.ok(match, 'Invalid source byte identity');
  const start = Number(match[1]);
  const end = Number(match[2]);
  assert.ok(Number.isSafeInteger(start) && Number.isSafeInteger(end) && end > start);
  return {
    start,
    end,
    ...(match[3] === undefined ? {} : { predecessorPartId: match[3] }),
  };
}

export class RawPartVerifier {
  private readonly hash: Hash = createHash('sha256');
  byteLength = 0;
  segmentCount = 0;
  lastIdentity = '';
  predecessorPartId?: string;
  observedSourceSize = 0;
  sourceCaptureComplete = false;
  checkpointVerified = false;
  private ancestryInitialized = false;

  addSegment(input: {
    identity: string;
    manifestStart: number;
    manifestEnd: number;
    manifestPredecessorPartId?: string;
    bytes: Uint8Array;
  }): void {
    const identity = sourceByteRange(input.identity);
    assert.equal(input.manifestStart, identity.start);
    assert.equal(input.manifestEnd, identity.end);
    assert.equal(input.manifestPredecessorPartId, identity.predecessorPartId);
    assert.equal(identity.end - identity.start, input.bytes.byteLength);
    assert.equal(identity.start, this.byteLength, 'Archive byte segment gap or overlap');
    if (!this.ancestryInitialized) {
      this.predecessorPartId = identity.predecessorPartId;
      this.ancestryInitialized = true;
    } else {
      assert.equal(identity.predecessorPartId, this.predecessorPartId);
    }
    this.hash.update(input.bytes);
    this.byteLength = identity.end;
    this.segmentCount += 1;
    this.lastIdentity = input.identity;
    this.checkpointVerified = false;
  }

  verifyCheckpoint(checkpoint: CompletedScanCheckpoint): void {
    assert.equal(checkpoint.archive_format_version, 2);
    assert.equal(checkpoint.record_count, this.segmentCount);
    assert.equal(checkpoint.last_complete_byte_offset, this.byteLength);
    assert.equal(checkpoint.complete_prefix_sha256, this.sha256());
    assert.equal(checkpoint.last_source_record_identity, this.lastIdentity || null);
    assert.ok(checkpoint.observed_file_size >= checkpoint.last_complete_byte_offset);
    this.observedSourceSize = checkpoint.observed_file_size;
    this.sourceCaptureComplete = checkpoint.observed_file_size === this.byteLength;
    this.checkpointVerified = true;
  }

  assertComplete(): void {
    assert.ok(this.checkpointVerified, 'Exact byte part has no verified completed checkpoint');
  }

  sha256(): string {
    return `sha256:${this.hash.copy().digest('hex')}`;
  }
}

export async function exportSessionDirectoryId(
  contributionId: string,
  sourceSessionId: string,
): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(`${contributionId}\0${sourceSessionId}`),
    ),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
