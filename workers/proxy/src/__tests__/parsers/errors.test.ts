import { describe, it, expect } from 'vitest';
import { parseError } from '../../parsers/errors';

describe('parseError', () => {
  it('should parse OpenAI-style nested error object', () => {
    const response = JSON.stringify({
      error: {
        type: 'invalid_request_error',
        message: 'Invalid request',
        code: 'invalid_api_key',
      },
    });

    const result = parseError(response, 401);

    expect(result).toEqual({
      type: 'invalid_request_error',
      message: 'Invalid request',
      code: 'invalid_api_key',
    });
  });

  it('should parse Anthropic-style top-level error fields', () => {
    const response = JSON.stringify({
      type: 'authentication_error',
      message: 'Invalid API key',
    });

    const result = parseError(response, 401);

    expect(result).toEqual({
      type: 'authentication_error',
      message: 'Invalid API key',
      code: undefined,
    });
  });

  it('should prefer nested error fields over top-level', () => {
    const response = JSON.stringify({
      type: 'top_level',
      message: 'top level message',
      error: {
        type: 'nested_error',
        message: 'nested message',
        code: 'error_code',
      },
    });

    const result = parseError(response, 500);

    expect(result).toEqual({
      type: 'nested_error',
      message: 'nested message',
      code: 'error_code',
    });
  });

  it('should handle error with only message', () => {
    const response = JSON.stringify({
      error: {
        message: 'Something went wrong',
      },
    });

    const result = parseError(response, 500);

    expect(result).toEqual({
      type: 'http_error',
      message: 'Something went wrong',
      code: undefined,
    });
  });

  it('should fallback to HTTP status when no message', () => {
    const response = JSON.stringify({
      error: {},
    });

    const result = parseError(response, 429);

    expect(result).toEqual({
      type: 'http_error',
      message: 'HTTP 429',
      code: undefined,
    });
  });

  it('should handle invalid JSON', () => {
    const response = 'not valid json';

    const result = parseError(response, 500);

    expect(result).toEqual({
      type: 'http_error',
      message: 'HTTP 500',
    });
  });

  it('should handle non-object response', () => {
    const response = JSON.stringify('string error');

    const result = parseError(response, 400);

    expect(result).toEqual({
      type: 'http_error',
      message: 'HTTP 400',
    });
  });

  it('should handle empty object response', () => {
    const response = JSON.stringify({});

    const result = parseError(response, 503);

    expect(result).toEqual({
      type: 'http_error',
      message: 'HTTP 503',
      code: undefined,
    });
  });

  it('should handle error object with non-string values', () => {
    const response = JSON.stringify({
      error: {
        type: 123,
        message: null,
        code: true,
      },
    });

    const result = parseError(response, 500);

    expect(result).toEqual({
      type: 'http_error',
      message: 'HTTP 500',
      code: undefined,
    });
  });

  it('should handle mixed valid and invalid error fields', () => {
    const response = JSON.stringify({
      error: {
        type: 'rate_limit_error',
        message: 'Rate limit exceeded',
        code: 12345,
      },
    });

    const result = parseError(response, 429);

    expect(result).toEqual({
      type: 'rate_limit_error',
      message: 'Rate limit exceeded',
      code: undefined,
    });
  });
});
