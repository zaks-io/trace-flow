import type { LLMError } from '@trace-flow/types';

/**
 * Extracts error information from failed LLM responses using regex.
 * Avoids parsing JSON to reduce processing overhead.
 *
 * Handles multiple error formats since different providers structure errors differently:
 * - OpenAI: `{ error: { type, message, code } }`
 * - Anthropic: `{ type, message }`
 * - Others may vary
 *
 * Checks both nested `error` object and root-level fields to support all providers.
 * Falls back to generic HTTP error if response body doesn't contain error details.
 */
export function parseError(responseBody: string, statusCode: number): LLMError {
  // Check if response has an "error" field (nested error object - OpenAI format)
  const hasErrorField = /"error"\s*:\s*\{/.test(responseBody);

  if (hasErrorField) {
    // Extract fields from nested error object
    // Match "error": { ... then find type/message/code anywhere within
    const errorStartIndex = responseBody.indexOf('"error"');
    if (errorStartIndex !== -1) {
      // Find the matching closing brace for the error object
      // This is a simplified approach - we'll search for fields after "error": {
      const afterError = responseBody.substring(errorStartIndex);

      // Match fields that appear after "error": { (may be nested)
      const nestedTypeMatch = /"type"\s*:\s*"([^"]+)"/.exec(afterError);
      const nestedMessageMatch = /"message"\s*:\s*"([^"]+)"/.exec(afterError);
      const nestedCodeMatch = /"code"\s*:\s*"([^"]+)"/.exec(afterError);

      if (nestedTypeMatch || nestedMessageMatch || nestedCodeMatch) {
        return {
          type: nestedTypeMatch?.[1] ?? 'http_error',
          message: nestedMessageMatch?.[1] ?? `HTTP ${statusCode}`,
          code: nestedCodeMatch?.[1],
        };
      }
    }
  }

  // Try root-level fields (Anthropic format)
  // Only match if we haven't already found nested error fields
  const rootTypeMatch = /^[^}]*"type"\s*:\s*"([^"]+)"/.exec(responseBody);
  const rootMessageMatch = /^[^}]*"message"\s*:\s*"([^"]+)"/.exec(responseBody);
  const rootCodeMatch = /^[^}]*"code"\s*:\s*"([^"]+)"/.exec(responseBody);

  if (rootTypeMatch || rootMessageMatch || rootCodeMatch) {
    return {
      type: rootTypeMatch?.[1] ?? 'http_error',
      message: rootMessageMatch?.[1] ?? `HTTP ${statusCode}`,
      code: rootCodeMatch?.[1],
    };
  }

  // Fallback to generic HTTP error
  return {
    type: 'http_error',
    message: `HTTP ${statusCode}`,
  };
}
