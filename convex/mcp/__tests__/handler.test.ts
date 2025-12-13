import { describe, it, expect } from 'vitest';
import { isRequest, isNotification, createErrorResponse, createSuccessResponse } from '../handler';
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
