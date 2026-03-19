import { describe, it, expect, vi } from 'vitest';
import type { Logger } from '@trace-flow/logging';
import { storeBodies } from '../storage';

const noopLogger: Logger = {
  child: () => noopLogger,
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  flush: () => Promise.resolve(),
};

describe('storeBodies', () => {
  it('should store request and response bodies in a single object', async () => {
    const mockStorage = {
      put: vi.fn().mockResolvedValue(undefined),
    } as unknown as R2Bucket;

    const requestId = 'test-request-id';
    const requestBody = 'request body content';
    const responseBody = 'response body content';

    await storeBodies(mockStorage, requestId, requestBody, responseBody, false, noopLogger);

    expect(mockStorage.put).toHaveBeenCalledTimes(1);
    expect(mockStorage.put).toHaveBeenCalledWith(
      'bodies/test-request-id',
      JSON.stringify({
        requestBody: 'request body content',
        responseBody: 'response body content',
      }),
      {
        httpMetadata: { contentType: 'application/json' },
      },
    );
  });

  it('should return true on success', async () => {
    const mockStorage = {
      put: vi.fn().mockResolvedValue(undefined),
    } as unknown as R2Bucket;

    const result = await storeBodies(
      mockStorage,
      'my-request-123',
      'test request',
      'test response',
      false,
      noopLogger,
    );

    expect(result).toBe(true);
  });

  it('should handle empty bodies', async () => {
    const mockStorage = {
      put: vi.fn().mockResolvedValue(undefined),
    } as unknown as R2Bucket;

    const requestId = 'empty-test';
    const requestBody = '';
    const responseBody = '';

    const result = await storeBodies(
      mockStorage,
      requestId,
      requestBody,
      responseBody,
      false,
      noopLogger,
    );

    expect(mockStorage.put).toHaveBeenCalledWith(
      'bodies/empty-test',
      JSON.stringify({
        requestBody: '',
        responseBody: '',
      }),
      {
        httpMetadata: { contentType: 'application/json' },
      },
    );
    expect(result).toBe(true);
  });

  it('should handle large bodies', async () => {
    const mockStorage = {
      put: vi.fn().mockResolvedValue(undefined),
    } as unknown as R2Bucket;

    const requestId = 'large-test';
    const largeRequestBody = 'a'.repeat(100000);
    const largeResponseBody = 'b'.repeat(200000);

    await storeBodies(
      mockStorage,
      requestId,
      largeRequestBody,
      largeResponseBody,
      false,
      noopLogger,
    );

    expect(mockStorage.put).toHaveBeenCalledWith(
      'bodies/large-test',
      JSON.stringify({
        requestBody: largeRequestBody,
        responseBody: largeResponseBody,
      }),
      {
        httpMetadata: { contentType: 'application/json' },
      },
    );
  });

  it('should pass orgId as custom metadata when provided', async () => {
    const mockStorage = {
      put: vi.fn().mockResolvedValue(undefined),
    } as unknown as R2Bucket;

    await storeBodies(mockStorage, 'meta-test', 'req', 'res', false, noopLogger, 'org_123');

    expect(mockStorage.put).toHaveBeenCalledWith(
      'bodies/meta-test',
      JSON.stringify({
        requestBody: 'req',
        responseBody: 'res',
      }),
      {
        customMetadata: { orgId: 'org_123' },
        httpMetadata: { contentType: 'application/json' },
      },
    );
  });

  it('should persist the truncated flag when present', async () => {
    const mockStorage = {
      put: vi.fn().mockResolvedValue(undefined),
    } as unknown as R2Bucket;

    await storeBodies(mockStorage, 'truncated-test', 'req', 'res', true, noopLogger);

    expect(mockStorage.put).toHaveBeenCalledWith(
      'bodies/truncated-test',
      JSON.stringify({
        requestBody: 'req',
        responseBody: 'res',
        truncated: true,
      }),
      {
        httpMetadata: { contentType: 'application/json' },
      },
    );
  });

  it('should handle storage errors gracefully', async () => {
    const mockStorage = {
      put: vi.fn().mockRejectedValue(new Error('Storage error')),
    } as unknown as R2Bucket;

    const requestId = 'error-test';
    const requestBody = 'request';
    const responseBody = 'response';

    const result = await storeBodies(
      mockStorage,
      requestId,
      requestBody,
      responseBody,
      false,
      noopLogger,
    );

    expect(result).toBe(false);
  });
});
