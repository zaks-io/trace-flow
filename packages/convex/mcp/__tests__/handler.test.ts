import { describe, it, expect } from 'vitest';
import {
  isRequest,
  isNotification,
  createErrorResponse,
  createSuccessResponse,
  resolveApiKeys,
} from '../handler';
import { JsonRpcErrorCode } from '../protocol';
import type { JsonRpcMessage } from '../protocol';

describe('isRequest', () => {
  it('returns true for message with numeric id', () => {
    const message: JsonRpcMessage = {
      jsonrpc: '2.0',
      id: 1,
      method: 'test',
    };
    expect(isRequest(message)).toBe(true);
  });

  it('returns true for message with string id', () => {
    const message: JsonRpcMessage = {
      jsonrpc: '2.0',
      id: 'request-1',
      method: 'test',
    };
    expect(isRequest(message)).toBe(true);
  });

  it('returns false for message without id', () => {
    const message: JsonRpcMessage = {
      jsonrpc: '2.0',
      method: 'notification',
    };
    expect(isRequest(message)).toBe(false);
  });

  it('returns false for message with undefined id', () => {
    const message = {
      jsonrpc: '2.0',
      id: undefined,
      method: 'notification',
    } as JsonRpcMessage;
    expect(isRequest(message)).toBe(false);
  });

  it('returns true for response message with id', () => {
    const message: JsonRpcMessage = {
      jsonrpc: '2.0',
      id: 1,
      result: {},
    };
    expect(isRequest(message)).toBe(true);
  });
});

describe('isNotification', () => {
  it('returns true for message without id', () => {
    const message: JsonRpcMessage = {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    };
    expect(isNotification(message)).toBe(true);
  });

  it('returns true for message with undefined id', () => {
    const message = {
      jsonrpc: '2.0',
      id: undefined,
      method: 'notification',
    } as JsonRpcMessage;
    expect(isNotification(message)).toBe(true);
  });

  it('returns false for message with numeric id', () => {
    const message: JsonRpcMessage = {
      jsonrpc: '2.0',
      id: 1,
      method: 'request',
    };
    expect(isNotification(message)).toBe(false);
  });

  it('returns false for message with string id', () => {
    const message: JsonRpcMessage = {
      jsonrpc: '2.0',
      id: 'request-1',
      method: 'request',
    };
    expect(isNotification(message)).toBe(false);
  });
});

describe('createErrorResponse', () => {
  it('creates response with correct jsonrpc version', () => {
    const response = createErrorResponse(1, JsonRpcErrorCode.InternalError, 'Error');
    expect(response.jsonrpc).toBe('2.0');
  });

  it('includes the request id', () => {
    const response = createErrorResponse(42, JsonRpcErrorCode.InternalError, 'Error');
    expect(response.id).toBe(42);
  });

  it('includes string id', () => {
    const response = createErrorResponse('req-1', JsonRpcErrorCode.InternalError, 'Error');
    expect(response.id).toBe('req-1');
  });

  it('allows null id', () => {
    const response = createErrorResponse(null, JsonRpcErrorCode.ParseError, 'Parse error');
    expect(response.id).toBeNull();
  });

  it('includes error code', () => {
    const response = createErrorResponse(1, JsonRpcErrorCode.MethodNotFound, 'Method not found');
    expect(response.error?.code).toBe(JsonRpcErrorCode.MethodNotFound);
  });

  it('includes error message', () => {
    const response = createErrorResponse(1, JsonRpcErrorCode.InvalidParams, 'Invalid params');
    expect(response.error?.message).toBe('Invalid params');
  });

  it('includes optional data', () => {
    const data = { details: 'more info', field: 'name' };
    const response = createErrorResponse(1, JsonRpcErrorCode.InvalidParams, 'Error', data);
    expect(response.error?.data).toEqual(data);
  });

  it('omits data when not provided', () => {
    const response = createErrorResponse(1, JsonRpcErrorCode.InternalError, 'Error');
    expect(response.error?.data).toBeUndefined();
  });

  it('does not include result field', () => {
    const response = createErrorResponse(1, JsonRpcErrorCode.InternalError, 'Error');
    expect(response.result).toBeUndefined();
  });
});

describe('createSuccessResponse', () => {
  it('creates response with correct jsonrpc version', () => {
    const response = createSuccessResponse(1, { data: 'test' });
    expect(response.jsonrpc).toBe('2.0');
  });

  it('includes numeric request id', () => {
    const response = createSuccessResponse(42, {});
    expect(response.id).toBe(42);
  });

  it('includes string request id', () => {
    const response = createSuccessResponse('req-123', {});
    expect(response.id).toBe('req-123');
  });

  it('includes result object', () => {
    const result = { tools: [{ name: 'test' }] };
    const response = createSuccessResponse(1, result);
    expect(response.result).toEqual(result);
  });

  it('includes result array', () => {
    const result = [1, 2, 3];
    const response = createSuccessResponse(1, result);
    expect(response.result).toEqual(result);
  });

  it('includes null result', () => {
    const response = createSuccessResponse(1, null);
    expect(response.result).toBeNull();
  });

  it('includes primitive result', () => {
    const response = createSuccessResponse(1, 'success');
    expect(response.result).toBe('success');
  });

  it('does not include error field', () => {
    const response = createSuccessResponse(1, {});
    expect(response.error).toBeUndefined();
  });
});

describe('resolveApiKeys', () => {
  const allKeys = [
    { _id: 'key-1', key: 'raw-secret-1' },
    { _id: 'key-2', key: 'raw-secret-2' },
    { _id: 'key-3', key: 'raw-secret-3' },
  ];

  it('returns all keys when requestedIds is undefined', () => {
    const result = resolveApiKeys(allKeys, undefined);
    expect(result).toEqual(['raw-secret-1', 'raw-secret-2', 'raw-secret-3']);
  });

  it('returns all keys when requestedIds is empty', () => {
    const result = resolveApiKeys(allKeys, []);
    expect(result).toEqual(['raw-secret-1', 'raw-secret-2', 'raw-secret-3']);
  });

  it('returns only matching keys when valid IDs provided', () => {
    const result = resolveApiKeys(allKeys, ['key-1', 'key-3']);
    expect(result).toEqual(['raw-secret-1', 'raw-secret-3']);
  });

  it('returns single matching key', () => {
    const result = resolveApiKeys(allKeys, ['key-2']);
    expect(result).toEqual(['raw-secret-2']);
  });

  it('returns error when an ID does not exist', () => {
    const result = resolveApiKeys(allKeys, ['key-1', 'key-unknown']);
    expect(result).toEqual({
      error: 'Invalid or unauthorized API key IDs: key-unknown',
    });
  });

  it('returns error listing all invalid IDs', () => {
    const result = resolveApiKeys(allKeys, ['bad-1', 'bad-2']);
    expect(result).toEqual({
      error: 'Invalid or unauthorized API key IDs: bad-1, bad-2',
    });
  });

  it('returns empty array when allKeys is empty and no IDs requested', () => {
    const result = resolveApiKeys([], undefined);
    expect(result).toEqual([]);
  });

  it('returns error when allKeys is empty but IDs are requested', () => {
    const result = resolveApiKeys([], ['key-1']);
    expect(result).toEqual({
      error: 'Invalid or unauthorized API key IDs: key-1',
    });
  });
});
