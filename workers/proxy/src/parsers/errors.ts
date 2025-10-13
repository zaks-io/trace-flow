import type { LLMError } from '@observe/types';

export function parseError(responseBody: string, statusCode: number): LLMError {
  try {
    const parsed = JSON.parse(responseBody) as unknown;

    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      const errorObj =
        obj.error && typeof obj.error === 'object' ? (obj.error as Record<string, unknown>) : null;

      return {
        type:
          (errorObj && typeof errorObj.type === 'string' ? errorObj.type : null) ??
          (typeof obj.type === 'string' ? obj.type : null) ??
          'http_error',
        message:
          (errorObj && typeof errorObj.message === 'string' ? errorObj.message : null) ??
          (typeof obj.message === 'string' ? obj.message : null) ??
          `HTTP ${statusCode}`,
        code:
          (errorObj && typeof errorObj.code === 'string' ? errorObj.code : null) ??
          (typeof obj.code === 'string' ? obj.code : null) ??
          undefined,
      };
    }
  } catch {
    return {
      type: 'http_error',
      message: `HTTP ${statusCode}`,
    };
  }

  return {
    type: 'http_error',
    message: `HTTP ${statusCode}`,
  };
}
