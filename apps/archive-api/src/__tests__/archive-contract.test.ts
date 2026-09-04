import { describe, expect, it } from 'vitest';
import vectorsJson from '../../../../packages/collector-archive/tests/fixtures/archive-identifiers.json?raw';
import { ArchiveContractError, assertIdentifier } from '../archive-contract';

const vectors = JSON.parse(vectorsJson) as {
  controls: string[];
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
