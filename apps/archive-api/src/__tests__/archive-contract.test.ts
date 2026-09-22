import { describe, expect, it } from 'vitest';
import vectorsJson from '../../../../packages/collector-archive/tests/fixtures/archive-identifiers.json?raw';
import {
  ArchiveContractError,
  assertArchiveRelativePath,
  assertIdentifier,
  assertTranscriptPartId,
  decodeBase64Bytes,
} from '../archive-contract';

const vectors = JSON.parse(vectorsJson) as {
  controls: string[];
  accepted: string[];
  boundary: {
    stable_id_prefix: string;
    non_bmp: string;
    target_identity_utf16_units: number;
  };
  over_limit: {
    stable_id_prefix: string;
    non_bmp: string;
    target_identity_utf16_units: number;
  };
};

const identityPrefix = 'claude:part:parent:claude:id:';
const identitySuffix = ':0';

function stableIdForTarget(targetUnits: number, prefix: string, nonBmp: string): string {
  const paddingUnits =
    targetUnits - identityPrefix.length - identitySuffix.length - prefix.length - nonBmp.length;
  return `${prefix}${'x'.repeat(paddingUnits)}${nonBmp}`;
}

function sourceRecordIdentity(stableId: string): string {
  return `${identityPrefix}${stableId}${identitySuffix}`;
}

describe('archive identifier contract', () => {
  it('rejects the shared C0 and DEL vectors', () => {
    for (const control of vectors.controls) {
      expect(() => assertIdentifier(`collector${control}`, 'invalid_record_identity')).toThrow(
        ArchiveContractError,
      );
    }
  });

  it('accepts the shared line-separator vectors', () => {
    for (const separator of vectors.accepted) {
      expect(() =>
        assertIdentifier(`collector${separator}`, 'invalid_record_identity'),
      ).not.toThrow();
    }
  });

  it('uses UTF-16 code units for shared non-BMP boundary vectors', () => {
    const boundary = sourceRecordIdentity(
      stableIdForTarget(
        vectors.boundary.target_identity_utf16_units,
        vectors.boundary.stable_id_prefix,
        vectors.boundary.non_bmp,
      ),
    );
    expect(boundary.length).toBe(vectors.boundary.target_identity_utf16_units);
    expect(() => assertIdentifier(boundary, 'invalid_record_identity')).not.toThrow();

    const overLimit = sourceRecordIdentity(
      stableIdForTarget(
        vectors.over_limit.target_identity_utf16_units,
        vectors.over_limit.stable_id_prefix,
        vectors.over_limit.non_bmp,
      ),
    );
    expect(overLimit.length).toBe(vectors.over_limit.target_identity_utf16_units);
    expect(() => assertIdentifier(overLimit, 'invalid_record_identity')).toThrow(
      ArchiveContractError,
    );
  });
});

describe('archive base64 contract', () => {
  it.each(['*===', 'YQ', 'YQ===', 'Y Q==', 'YQ==\n'])(
    'rejects invalid or noncanonical base64 %#',
    (value) => {
      expect(() => decodeBase64Bytes(value)).toThrowError(
        expect.objectContaining({ errorClass: 'invalid_payload_encoding' }),
      );
    },
  );
});

describe('archive transcript part contract', () => {
  it('accepts canonical Codex rewrite parts and rejects noncanonical digests', () => {
    expect(() =>
      assertTranscriptPartId('codex', `codex:part:sha256:${'a'.repeat(64)}`),
    ).not.toThrow();
    expect(() =>
      assertTranscriptPartId('codex', `codex:part:sha256:${'A'.repeat(64)}`),
    ).toThrowError(ArchiveContractError);
    expect(() =>
      assertTranscriptPartId('codex', `codex:part:sha256:${'a'.repeat(63)}`),
    ).toThrowError(ArchiveContractError);
  });
});

describe('archive sidecar path contract', () => {
  it('accepts one Claude tool-result filename and rejects traversal or nested paths', () => {
    expect(() => assertArchiveRelativePath('tool-results/result.txt')).not.toThrow();
    for (const value of [
      '/tool-results/result.txt',
      'tool-results/../secret',
      'tool-results/nested/result.txt',
      'other/result.txt',
      'tool-results\\result.txt',
    ]) {
      expect(() => assertArchiveRelativePath(value)).toThrowError(ArchiveContractError);
    }
  });
});
