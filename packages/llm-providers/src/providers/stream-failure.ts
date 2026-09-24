import type { LLMError, SSEStreamData } from '@trace-flow/types';
import { boundedSSEMetadataValue } from './sse-state';

const STREAM_INCOMPLETE_ERROR: LLMError = {
  type: 'stream_incomplete',
  message: 'Upstream stream ended before its terminal event',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorPayload(value: Record<string, unknown>): Record<string, unknown> | undefined {
  if (isRecord(value.error)) return value.error;
  if (isRecord(value.response) && isRecord(value.response.error)) return value.response.error;
  if (value.type === 'error') return value;
  return undefined;
}

function boundedField(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' ? boundedSSEMetadataValue(value) : undefined;
}

/**
 * Reads a provider error delivered as a stream event after a 200 response:
 * Anthropic `event: error`, OpenAI/OpenRouter/Gemini `data: {"error": …}`, and
 * Responses API `error` / `response.failed` events.
 */
function parseStreamError(value: unknown): LLMError | undefined {
  if (!isRecord(value)) return undefined;
  const payload = errorPayload(value);
  if (!payload) return undefined;

  const error: LLMError = {
    type: boundedField(payload.type) ?? boundedField(payload.status) ?? 'stream_error',
  };
  if (typeof payload.message === 'string') error.message = payload.message;
  const code = boundedField(payload.code);
  if (code) error.code = code;
  return error;
}

/** Keeps the first reported error; later ones are usually fallout from it. */
export function recordStreamError(state: SSEStreamData, value: unknown): boolean {
  const error = parseStreamError(value);
  if (!error) return false;
  state.error ??= error;
  return true;
}

/**
 * Failure for a stream that closed cleanly at the transport level. Providers
 * whose protocol ends with an explicit terminal event pass `expectsTerminal`
 * for the last message; a missing `messageStop` then means truncated output.
 */
export function streamFailure(
  state: SSEStreamData,
  expectsTerminal: (message: SSEStreamData['messages'][number]) => boolean,
): LLMError | undefined {
  if (state.error) return state.error;
  const last = state.messages[state.messages.length - 1];
  if (last && !last.messageStop && expectsTerminal(last)) return STREAM_INCOMPLETE_ERROR;
  return undefined;
}
