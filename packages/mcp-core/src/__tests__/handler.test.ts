import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  isRequest,
  isNotification,
  createErrorResponse,
  createSuccessResponse,
  dispatchToolCall,
} from '../handler';
import { resolveApiKeyIds, type McpBackend } from '../backend';
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

describe('resolveApiKeyIds', () => {
  const allKeys = [
    { id: 'key-1', name: null, expiresAt: Number.MAX_SAFE_INTEGER },
    { id: 'key-2', name: null, expiresAt: Number.MAX_SAFE_INTEGER },
    { id: 'key-3', name: null, expiresAt: Number.MAX_SAFE_INTEGER },
  ];

  it('returns all ids when requestedIds is undefined', () => {
    expect(resolveApiKeyIds(allKeys, undefined)).toEqual({
      ok: true,
      keyIds: ['key-1', 'key-2', 'key-3'],
    });
  });

  it('returns all ids when requestedIds is empty', () => {
    expect(resolveApiKeyIds(allKeys, [])).toEqual({
      ok: true,
      keyIds: ['key-1', 'key-2', 'key-3'],
    });
  });

  it('returns only matching ids when valid IDs provided', () => {
    expect(resolveApiKeyIds(allKeys, ['key-1', 'key-3'])).toEqual({
      ok: true,
      keyIds: ['key-1', 'key-3'],
    });
  });

  it('dedupes requested ids while preserving order', () => {
    expect(resolveApiKeyIds(allKeys, ['key-2', 'key-1', 'key-2'])).toEqual({
      ok: true,
      keyIds: ['key-2', 'key-1'],
    });
  });

  it('returns single matching id', () => {
    expect(resolveApiKeyIds(allKeys, ['key-2'])).toEqual({ ok: true, keyIds: ['key-2'] });
  });

  it('flags an ID that does not exist', () => {
    expect(resolveApiKeyIds(allKeys, ['key-1', 'key-unknown'])).toEqual({
      ok: false,
      invalidIds: ['key-unknown'],
    });
  });

  it('flags all invalid IDs', () => {
    expect(resolveApiKeyIds(allKeys, ['bad-1', 'bad-2'])).toEqual({
      ok: false,
      invalidIds: ['bad-1', 'bad-2'],
    });
  });

  it('returns empty id list when allKeys is empty and no IDs requested', () => {
    expect(resolveApiKeyIds([], undefined)).toEqual({ ok: true, keyIds: [] });
  });

  it('flags requested IDs when allKeys is empty', () => {
    expect(resolveApiKeyIds([], ['key-1'])).toEqual({ ok: false, invalidIds: ['key-1'] });
  });
});

describe('dispatchToolCall', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createBackend(overrides: Partial<McpBackend> = {}): McpBackend {
    return {
      mintToken: vi.fn(async () => 'tb-token'),
      listApiKeys: vi.fn(async () => []),
      resolveKeyIds: vi.fn(async () => ({ ok: true as const, keyIds: [] })),
      getUserContext: vi.fn(async () => ({ enabled: true, retentionDays: 30 })),
      ...overrides,
    };
  }

  it('rejects disabled users before listing API keys', async () => {
    const listApiKeys = vi.fn(async () => [
      { id: 'key-1', name: 'prod', expiresAt: Number.MAX_SAFE_INTEGER },
    ]);
    const backend = createBackend({
      listApiKeys,
      getUserContext: vi.fn(async () => ({ enabled: false, retentionDays: 30 })),
    });

    const response = await dispatchToolCall(backend, 'https://api.tinybird.test', 1, {
      name: 'list_api_keys',
      arguments: {},
    });

    expect(response.error?.code).toBe(JsonRpcErrorCode.InvalidRequest);
    expect(response.error?.message).toBe('User not found or not enabled');
    expect(listApiKeys).not.toHaveBeenCalled();
  });

  it('rejects unknown tools before hitting the backend', async () => {
    const backend = createBackend();

    const response = await dispatchToolCall(backend, 'https://api.tinybird.test', 1, {
      name: 'not_a_tool',
      arguments: {},
    });

    expect(response.error?.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(response.error?.message).toBe('Unknown tool: not_a_tool');
    expect(backend.getUserContext).not.toHaveBeenCalled();
    expect(backend.resolveKeyIds).not.toHaveBeenCalled();
  });

  it('lists API keys through the backend formatter', async () => {
    const listApiKeys = vi.fn(async () => [
      { id: 'key-1', name: 'prod', expiresAt: Date.now() + 60_000 },
    ]);
    const backend = createBackend({ listApiKeys });

    const response = await dispatchToolCall(backend, 'https://api.tinybird.test', 1, {
      name: 'list_api_keys',
      arguments: {},
    });

    expect(response.error).toBeUndefined();
    expect(listApiKeys).toHaveBeenCalledOnce();
    const result = response.result as { content: [{ text: string }] };
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      api_keys: [{ id: 'key-1', name: 'prod' }],
      total: 1,
    });
  });

  it('rejects api_key_ids that are not string arrays', async () => {
    const backend = createBackend();

    const response = await dispatchToolCall(backend, 'https://api.tinybird.test', 1, {
      name: 'list_traces',
      arguments: { api_key_ids: 'key-1' },
    });

    expect(response.error?.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(response.error?.message).toBe('api_key_ids must be an array of strings');
    expect(backend.resolveKeyIds).not.toHaveBeenCalled();
  });

  it('rejects unowned api key ids', async () => {
    const backend = createBackend({
      resolveKeyIds: vi.fn(async () => ({ ok: false as const, invalidIds: ['bad-1', 'bad-2'] })),
    });

    const response = await dispatchToolCall(backend, 'https://api.tinybird.test', 1, {
      name: 'list_traces',
      arguments: { api_key_ids: ['bad-1', 'bad-2'] },
    });

    expect(response.error?.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(response.error?.message).toContain('bad-1, bad-2');
  });

  it('dispatches tool calls with resolved keys and a minted Tinybird token', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [
            {
              trace_id: 'abcdef0123456789abcdef0123456789',
              timestamp: '2026-03-29T12:00:00.000Z',
              duration_ms: 10,
              status: 'STATUS_CODE_OK',
              provider: 'openai',
              model: 'gpt-5',
              prompt_tokens: 1,
              completion_tokens: 2,
              total_tokens: 3,
              cost_usd: 0.01,
              total_count: 1,
            },
          ],
        }),
    } as Response);

    const mintToken = vi.fn(async () => 'tb-token');
    const backend = createBackend({
      mintToken,
      resolveKeyIds: vi.fn(async () => ({ ok: true as const, keyIds: ['key-1'] })),
    });

    const response = await dispatchToolCall(backend, 'https://api.tinybird.test', 1, {
      name: 'list_traces',
      arguments: { api_key_ids: ['key-1'] },
    });

    expect(response.error).toBeUndefined();
    expect(mintToken).toHaveBeenCalledWith(
      [{ type: 'PIPES:READ', resource: 'mcp_traces_list' }],
      ['key-1'],
      30,
    );
  });

  it('maps thrown tool errors to JSON-RPC internal errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Tinybird down'));
    const backend = createBackend({
      resolveKeyIds: vi.fn(async () => ({ ok: true as const, keyIds: ['key-1'] })),
    });

    const response = await dispatchToolCall(backend, 'https://api.tinybird.test', 1, {
      name: 'list_traces',
      arguments: { api_key_ids: ['key-1'] },
    });

    expect(response.error?.code).toBe(JsonRpcErrorCode.InternalError);
    expect(response.error?.message).toBe('Tinybird down');
    expect(response.result).toBeUndefined();
  });
});
