import { describe, it, expect, vi } from 'vitest';
import { storeRequestResponse } from '../storage';

describe('storeRequestResponse', () => {
  it('should store both request and response bodies', async () => {
    const mockStorage = {
      put: vi.fn().mockResolvedValue(undefined),
    } as unknown as R2Bucket;

    const requestId = 'test-request-id';
    const requestBody = 'request body content';
    const responseBody = 'response body content';

    await storeRequestResponse(mockStorage, requestId, requestBody, responseBody);

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(mockStorage.put).toHaveBeenCalledTimes(2);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(mockStorage.put).toHaveBeenCalledWith(
      'requests/test-request-id',
      'request body content',
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(mockStorage.put).toHaveBeenCalledWith(
      'responses/test-request-id',
      'response body content',
    );
  });

  it('should return correct keys', async () => {
    const mockStorage = {
      put: vi.fn().mockResolvedValue(undefined),
    } as unknown as R2Bucket;

    const requestId = 'my-request-123';
    const requestBody = 'test request';
    const responseBody = 'test response';

    const result = await storeRequestResponse(mockStorage, requestId, requestBody, responseBody);

    expect(result).toEqual({
      requestBodyKey: 'requests/my-request-123',
      responseBodyKey: 'responses/my-request-123',
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
    await storeRequestResponse(mockStorage, requestId, requestBody, responseBody);
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

    const result = await storeRequestResponse(mockStorage, requestId, requestBody, responseBody);

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(mockStorage.put).toHaveBeenCalledWith('requests/empty-test', '');
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(mockStorage.put).toHaveBeenCalledWith('responses/empty-test', '');
    expect(result).toEqual({
      requestBodyKey: 'requests/empty-test',
      responseBodyKey: 'responses/empty-test',
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

    await storeRequestResponse(mockStorage, requestId, largeRequestBody, largeResponseBody);

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(mockStorage.put).toHaveBeenCalledWith('requests/large-test', largeRequestBody);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(mockStorage.put).toHaveBeenCalledWith('responses/large-test', largeResponseBody);
  });

  it('should handle storage errors gracefully', async () => {
    const mockStorage = {
      put: vi.fn().mockRejectedValue(new Error('Storage error')),
    } as unknown as R2Bucket;

    const requestId = 'error-test';
    const requestBody = 'request';
    const responseBody = 'response';

    const result = await storeRequestResponse(mockStorage, requestId, requestBody, responseBody);

    expect(result).toEqual({
      requestBodyKey: 'requests/error-test',
      responseBodyKey: 'responses/error-test',
      stored: false,
    });
  });

  it('should suppress console.log calls', async () => {
    const mockStorage = {
      put: vi.fn().mockResolvedValue(undefined),
    } as unknown as R2Bucket;
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const requestId = 'console-test';
    const requestBody = 'request';
    const responseBody = 'response';

    await storeRequestResponse(mockStorage, requestId, requestBody, responseBody);

    expect(consoleLogSpy).toHaveBeenCalled();

    consoleLogSpy.mockRestore();
  });
});
