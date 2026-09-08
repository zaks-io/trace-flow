import assert from 'node:assert/strict';
import { describe, test } from 'bun:test';
import { classifyBucketResponse, productionArchiveBucket } from './archive-r2-bucket';

describe('production archive bucket lookup', () => {
  test('treats only the R2 NoSuchBucket response as missing', () => {
    assert.deepEqual(
      classifyBucketResponse(404, {
        success: false,
        errors: [{ code: 10006, message: 'The specified bucket does not exist.' }],
      }),
      { state: 'missing' },
    );
  });

  test('does not treat authentication, service, or unrelated 404 failures as missing', () => {
    for (const [httpStatus, code] of [
      [403, 10003],
      [503, 10001],
      [404, 10007],
    ] as const) {
      assert.throws(
        () =>
          classifyBucketResponse(httpStatus, {
            success: false,
            errors: [{ code, message: 'request failed' }],
          }),
        new RegExp(`HTTP ${httpStatus}`, 'u'),
      );
    }
  });

  test('requires the exact production bucket in a successful response', () => {
    assert.deepEqual(
      classifyBucketResponse(200, {
        success: true,
        result: { name: productionArchiveBucket.name },
      }),
      { state: 'exists' },
    );
    assert.throws(() =>
      classifyBucketResponse(200, { success: true, result: { name: 'wrong-bucket' } }),
    );
  });
});
