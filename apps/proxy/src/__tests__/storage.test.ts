import { describe, it, expect, vi } from 'vitest';
import type { Logger } from '@trace-flow/logging';
import { isEncryptedStoredBodiesPayload } from '@trace-flow/types';
import { decryptStoredBodyPayload } from '@trace-flow/utils';
import { storeBodies } from '../storage';

const ROOT_KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
const encryption = { rootKeyBase64: ROOT_KEY, keyId: 'v1' };

const noopLogger: Logger = {
  child: () => noopLogger,
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  flush: () => Promise.resolve(),
};

async function decryptPutPayload(mockStorage: R2Bucket, orgId = 'org_123') {
  const calls = (mockStorage as unknown as { put: ReturnType<typeof vi.fn> }).put.mock.calls;
  const [, storedBody] = calls[0] as [string, string, R2PutOptions];
  const parsed: unknown = JSON.parse(storedBody);
  if (!isEncryptedStoredBodiesPayload(parsed)) {
    throw new Error('Expected encrypted stored body payload');
  }

  return JSON.parse(
    await decryptStoredBodyPayload(parsed, {
      rootKeyBase64: ROOT_KEY,
      orgId,
      objectKey: 'bodies/test-request-id',
    }),
  );
}

describe('storeBodies', () => {
  it('should store encrypted request and response bodies in a single object', async () => {
    const mockStorage = {
      put: vi.fn().mockResolvedValue(undefined),
    } as unknown as R2Bucket;

    const requestId = 'test-request-id';
    const requestBody = 'request body content';
    const responseBody = 'response body content';

    await storeBodies(
      mockStorage,
      requestId,
      requestBody,
      responseBody,
      false,
      noopLogger,
      'org_123',
      encryption,
    );

    expect(mockStorage.put).toHaveBeenCalledTimes(1);
    const calls = (mockStorage as unknown as { put: ReturnType<typeof vi.fn> }).put.mock.calls;
    const [key, storedBody, options] = calls[0] as [string, string, R2PutOptions];
    expect(key).toBe('bodies/test-request-id');
    expect(storedBody).not.toContain(requestBody);
    expect(storedBody).not.toContain(responseBody);
    expect(options).toEqual({
      customMetadata: { orgId: 'org_123' },
      httpMetadata: { contentType: 'application/json' },
    });
    await expect(decryptPutPayload(mockStorage)).resolves.toEqual({
      requestBody: 'request body content',
      responseBody: 'response body content',
    });
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
      'org_123',
      encryption,
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
      'org_123',
      encryption,
    );

    expect(mockStorage.put).toHaveBeenCalledWith('bodies/empty-test', expect.any(String), {
      customMetadata: { orgId: 'org_123' },
      httpMetadata: { contentType: 'application/json' },
    });
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
      'org_123',
      encryption,
    );

    expect(mockStorage.put).toHaveBeenCalledWith('bodies/large-test', expect.any(String), {
      customMetadata: { orgId: 'org_123' },
      httpMetadata: { contentType: 'application/json' },
    });
    const [, storedBody] = (mockStorage as unknown as { put: ReturnType<typeof vi.fn> }).put.mock
      .calls[0] as [string, string, R2PutOptions];
    expect(storedBody).not.toContain(largeRequestBody);
    expect(storedBody).not.toContain(largeResponseBody);
  });

  it('should pass orgId as custom metadata when provided', async () => {
    const mockStorage = {
      put: vi.fn().mockResolvedValue(undefined),
    } as unknown as R2Bucket;

    await storeBodies(
      mockStorage,
      'meta-test',
      'req',
      'res',
      false,
      noopLogger,
      'org_123',
      encryption,
    );

    expect(mockStorage.put).toHaveBeenCalledWith('bodies/meta-test', expect.any(String), {
      customMetadata: { orgId: 'org_123' },
      httpMetadata: { contentType: 'application/json' },
    });
  });

  it('should persist the truncated flag when present', async () => {
    const mockStorage = {
      put: vi.fn().mockResolvedValue(undefined),
    } as unknown as R2Bucket;

    await storeBodies(
      mockStorage,
      'test-request-id',
      'req',
      'res',
      true,
      noopLogger,
      'org_123',
      encryption,
    );

    await expect(decryptPutPayload(mockStorage)).resolves.toEqual({
      requestBody: 'req',
      responseBody: 'res',
      truncated: true,
    });
  });

  it('should return false when encryption context is missing', async () => {
    const mockStorage = {
      put: vi.fn().mockResolvedValue(undefined),
    } as unknown as R2Bucket;

    await expect(
      storeBodies(
        mockStorage,
        'missing-org',
        'req',
        'res',
        false,
        noopLogger,
        undefined,
        encryption,
      ),
    ).resolves.toBe(false);
    await expect(
      storeBodies(mockStorage, 'missing-key', 'req', 'res', false, noopLogger, 'org_123'),
    ).resolves.toBe(false);
    expect(mockStorage.put).not.toHaveBeenCalled();
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
      'org_123',
      encryption,
    );

    expect(result).toBe(false);
  });
});
