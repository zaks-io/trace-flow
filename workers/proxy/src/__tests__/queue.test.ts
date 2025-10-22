import { describe, it, expect } from 'vitest';
import { createQueueMessage } from '../queue';

describe('createQueueMessage', () => {
  const baseParams = {
    requestId: 'test-123',
    traceId: 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6',
    apiKey: 'api-key-123',
    targetUrl: 'https://api.openai.com/v1/chat/completions',
    responseStatus: 200,
    requestStart: 1000,
    requestSent: 1100,
    firstTokenReceived: 1200,
    responseComplete: 1500,
    latency: 500,
    requestBodyKey: 'requests/a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6',
    responseBodyKey: 'responses/a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6',
    tokens: {
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    },
    error: undefined,
  };

  it('should create queue message with all required fields', () => {
    const result = createQueueMessage(baseParams);

    expect(result).toMatchObject({
      requestId: 'test-123',
      traceId: 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6',
      apiKey: 'api-key-123',
      targetUrl: 'https://api.openai.com/v1/chat/completions',
      requestBodyKey: 'requests/a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6',
      responseBodyKey: 'responses/a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6',
      tokens: {
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
      },
      error: undefined,
    });
  });

  it('should create correct timing structure', () => {
    const result = createQueueMessage(baseParams);

    expect(result.timing).toEqual({
      requestStart: 1000,
      requestSent: 1100,
      firstTokenReceived: 1200,
      responseComplete: 1500,
    });
  });

  it('should create correct request structure', () => {
    const result = createQueueMessage(baseParams);

    expect(result.request).toEqual({
      id: 'test-123',
      provider: 'openai',
      model: 'unknown',
      messages: [],
      timestamp: 1000,
    });
  });

  it('should create correct response structure', () => {
    const result = createQueueMessage(baseParams);

    expect(result.response).toEqual({
      id: 'test-123',
      provider: 'openai',
      status: 200,
      timestamp: 1500,
      latency: 500,
    });
  });

  it('should extract provider from OpenAI URL', () => {
    const params = {
      ...baseParams,
      targetUrl: 'https://api.openai.com/v1/chat/completions',
    };

    const result = createQueueMessage(params);

    expect(result.request.provider).toBe('openai');
  });

  it('should extract provider from Anthropic URL', () => {
    const params = {
      ...baseParams,
      targetUrl: 'https://api.anthropic.com/v1/messages',
    };

    const result = createQueueMessage(params);

    expect(result.request.provider).toBe('anthropic');
  });

  it('should include SSE stream data when provided and non-empty', () => {
    const sseStreamData = {
      messages: [
        {
          messageStart: 1150,
          messageStop: 1480,
          events: [
            { type: 'message_start', timestamp: 1150, data: '{}' },
            { type: 'content_block_delta', timestamp: 1250, data: '{}' },
            { type: 'message_stop', timestamp: 1480, data: '{}' },
          ],
          usage: {
            input_tokens: 100,
            output_tokens: 50,
          },
        },
      ],
    };

    const params = {
      ...baseParams,
      sseStreamData,
    };

    const result = createQueueMessage(params);

    expect(result.sseStreamData).toEqual(sseStreamData);
  });

  it('should exclude SSE stream data when messages array is empty', () => {
    const params = {
      ...baseParams,
      sseStreamData: { messages: [] },
    };

    const result = createQueueMessage(params);

    expect(result.sseStreamData).toBeUndefined();
  });

  it('should include SSE stream data with multiple messages', () => {
    const sseStreamData = {
      messages: [
        {
          messageStart: 1150,
          messageStop: 1480,
          events: [
            { type: 'message_start', timestamp: 1150, data: '{}' },
            { type: 'message_stop', timestamp: 1480, data: '{}' },
          ],
        },
        {
          messageStart: 2000,
          messageStop: 2300,
          events: [
            { type: 'message_start', timestamp: 2000, data: '{}' },
            { type: 'message_stop', timestamp: 2300, data: '{}' },
          ],
        },
      ],
    };

    const params = {
      ...baseParams,
      sseStreamData,
    };

    const result = createQueueMessage(params);

    expect(result.sseStreamData).toEqual(sseStreamData);
    expect(result.sseStreamData?.messages.length).toBe(2);
  });

  it('should handle error response without tokens', () => {
    const params = {
      ...baseParams,
      responseStatus: 401,
      tokens: undefined,
      error: {
        type: 'invalid_request_error',
        message: 'Invalid API key',
        code: 'invalid_api_key',
      },
    };

    const result = createQueueMessage(params);

    expect(result.tokens).toBeUndefined();
    expect(result.error).toEqual({
      type: 'invalid_request_error',
      message: 'Invalid API key',
      code: 'invalid_api_key',
    });
  });

  it('should handle undefined firstTokenReceived', () => {
    const params = {
      ...baseParams,
      firstTokenReceived: undefined,
    };

    const result = createQueueMessage(params);

    expect(result.timing.firstTokenReceived).toBeUndefined();
  });

  it('should handle different provider URLs', () => {
    const providers = [
      { url: 'https://api.openai.com/v1', expected: 'openai' },
      { url: 'https://api.anthropic.com/v1', expected: 'anthropic' },
      { url: 'https://generativelanguage.googleapis.com/v1', expected: 'google' },
      { url: 'https://api.mistral.ai/v1', expected: 'mistral' },
      { url: 'https://api.cohere.ai/v1', expected: 'cohere' },
      { url: 'https://api.perplexity.ai/v1', expected: 'perplexity' },
      { url: 'https://api.example.com/v1', expected: 'api.example.com' },
    ];

    providers.forEach(({ url, expected }) => {
      const params = { ...baseParams, targetUrl: url };
      const result = createQueueMessage(params);
      expect(result.request.provider).toBe(expected);
      expect(result.response.provider).toBe(expected);
    });
  });

  it('should create valid queue message structure', () => {
    const result = createQueueMessage(baseParams);

    expect(result).toHaveProperty('requestId');
    expect(result).toHaveProperty('apiKey');
    expect(result).toHaveProperty('targetUrl');
    expect(result).toHaveProperty('request');
    expect(result).toHaveProperty('response');
    expect(result).toHaveProperty('requestBodyKey');
    expect(result).toHaveProperty('responseBodyKey');
    expect(result).toHaveProperty('timing');
    expect(result).toHaveProperty('tokens');
    expect(result).toHaveProperty('error');
  });

  it('should include truncated field when provided', () => {
    const params = {
      ...baseParams,
      truncated: true,
    };

    const result = createQueueMessage(params);

    expect(result.truncated).toBe(true);
  });

  it('should exclude truncated field when not provided', () => {
    const result = createQueueMessage(baseParams);

    expect(result.truncated).toBeUndefined();
  });

  it('should exclude truncated field when explicitly false', () => {
    const params = {
      ...baseParams,
      truncated: false,
    };

    const result = createQueueMessage(params);

    expect(result.truncated).toBe(false);
  });

  it('should handle missing R2 keys when storage fails', () => {
    const params = {
      ...baseParams,
      requestBodyKey: undefined,
      responseBodyKey: undefined,
    };

    const result = createQueueMessage(params);

    expect(result.requestBodyKey).toBeUndefined();
    expect(result.responseBodyKey).toBeUndefined();
  });

  it('should include R2 keys when storage succeeds', () => {
    const params = {
      ...baseParams,
      requestBodyKey: 'requests/test-123',
      responseBodyKey: 'responses/test-123',
    };

    const result = createQueueMessage(params);

    expect(result.requestBodyKey).toBe('requests/test-123');
    expect(result.responseBodyKey).toBe('responses/test-123');
  });
});
