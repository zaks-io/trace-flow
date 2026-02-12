import { describe, it, expect, vi } from 'vitest';
import { storeRequestResponse } from '../storage';

describe('storeRequestResponse', () => {
  it('should store both request and response bodies with tier prefix', async () => {
    const mockStorage = {
      put: vi.fn().mockResolvedValue(undefined),
    } as unknown as R2Bucket;

    const requestId = 'test-request-id';
    const requestBody = 'request body content';
    const responseBody = 'response body content';

    await storeRequestResponse(mockStorage, requestId, requestBody, responseBody, 'pro');

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(mockStorage.put).toHaveBeenCalledTimes(2);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(mockStorage.put).toHaveBeenCalledWith(
      'requests/pro/test-request-id',
      'request body content',
      {},
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(mockStorage.put).toHaveBeenCalledWith(
      'responses/pro/test-request-id',
      'response body content',
      {},
    );
  });

  it('should default to hobby tier when tier not provided', async () => {
    const mockStorage = {
      put: vi.fn().mockResolvedValue(undefined),
    } as unknown as R2Bucket;

    const requestId = 'my-request-123';
    const requestBody = 'test request';
    const responseBody = 'test response';

    const result = await storeRequestResponse(mockStorage, requestId, requestBody, responseBody);

    expect(result).toEqual({
      requestBodyKey: 'requests/hobby/my-request-123',
      responseBodyKey: 'responses/hobby/my-request-123',
      stored: true,
    });
  });

  it('should return correct keys with tier prefix', async () => {
    const mockStorage = {
      put: vi.fn().mockResolvedValue(undefined),
    } as unknown as R2Bucket;

    const requestId = 'my-request-123';
    const requestBody = 'test request';
    const responseBody = 'test response';

    const result = await storeRequestResponse(
      mockStorage,
      requestId,
      requestBody,
      responseBody,
      'pro',
    );

    expect(result).toEqual({
      requestBodyKey: 'requests/pro/my-request-123',
      responseBodyKey: 'responses/pro/my-request-123',
      stored: true,
    });
  });

  it('should handle concurrent uploads', async () => {
    const mockStorage = {
      put: vi.fn().mockImplementation((_key: string) => {
        return new Promise((resolve) => {
          setTimeout(() => resolve(undefined), 10);
        });
      }),
    } as unknown as R2Bucket;

    const requestId = 'concurrent-test';
    const requestBody = 'request';
    const responseBody = 'response';

    const startTime = Date.now();
    await storeRequestResponse(mockStorage, requestId, requestBody, responseBody, 'hobby');
    const endTime = Date.now();

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(mockStorage.put).toHaveBeenCalledTimes(2);
    expect(endTime - startTime).toBeLessThan(20);
  });

  it('should handle empty bodies', async () => {
    const mockStorage = {
      put: vi.fn().mockResolvedValue(undefined),
    } as unknown as R2Bucket;

    const requestId = 'empty-test';
    const requestBody = '';
    const responseBody = '';

    const result = await storeRequestResponse(
      mockStorage,
      requestId,
      requestBody,
      responseBody,
      'hobby',
    );

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(mockStorage.put).toHaveBeenCalledWith('requests/hobby/empty-test', '', {});
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(mockStorage.put).toHaveBeenCalledWith('responses/hobby/empty-test', '', {});
    expect(result).toEqual({
      requestBodyKey: 'requests/hobby/empty-test',
      responseBodyKey: 'responses/hobby/empty-test',
      stored: true,
    });
  });

  it('should handle large bodies', async () => {
    const mockStorage = {
      put: vi.fn().mockResolvedValue(undefined),
    } as unknown as R2Bucket;

    const requestId = 'large-test';
    const largeRequestBody = 'a'.repeat(100000);
    const largeResponseBody = 'b'.repeat(200000);

    await storeRequestResponse(mockStorage, requestId, largeRequestBody, largeResponseBody, 'pro');

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(mockStorage.put).toHaveBeenCalledWith('requests/pro/large-test', largeRequestBody, {});
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(mockStorage.put).toHaveBeenCalledWith('responses/pro/large-test', largeResponseBody, {});
  });

  it('should pass orgId as custom metadata when provided', async () => {
    const mockStorage = {
      put: vi.fn().mockResolvedValue(undefined),
    } as unknown as R2Bucket;

    await storeRequestResponse(mockStorage, 'meta-test', 'req', 'res', 'pro', 'org_123');

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(mockStorage.put).toHaveBeenCalledWith('requests/pro/meta-test', 'req', {
      customMetadata: { orgId: 'org_123' },
    });
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(mockStorage.put).toHaveBeenCalledWith('responses/pro/meta-test', 'res', {
      customMetadata: { orgId: 'org_123' },
    });
  });

  it('should handle storage errors gracefully', async () => {
    const mockStorage = {
      put: vi.fn().mockRejectedValue(new Error('Storage error')),
    } as unknown as R2Bucket;

    const requestId = 'error-test';
    const requestBody = 'request';
    const responseBody = 'response';

    const result = await storeRequestResponse(
      mockStorage,
      requestId,
      requestBody,
      responseBody,
      'hobby',
    );

    expect(result).toEqual({
      requestBodyKey: 'requests/hobby/error-test',
      responseBodyKey: 'responses/hobby/error-test',
      stored: false,
    });
  });
});
