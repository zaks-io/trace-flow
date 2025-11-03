import type { LLMResponseMetadata } from '@observe/types';

/**
 * Regex patterns for extracting metadata from SSE event data strings.
 * Uses regex instead of JSON parsing for performance - avoids parsing large JSON objects
 * when we only need specific fields. Patterns are designed to be robust to whitespace variations.
 */

// OpenAI-compatible patterns
const OPENAI_ID_PATTERN = /"id"\s*:\s*"([^"]+)"/;
const OPENAI_MODEL_PATTERN = /"model"\s*:\s*"([^"]+)"/;
const OPENAI_OBJECT_PATTERN = /"object"\s*:\s*"([^"]+)"/;
const OPENAI_CREATED_PATTERN = /"created"\s*:\s*(\d+)/;
const OPENAI_FINISH_REASON_PATTERN = /"finish_reason"\s*:\s*"([^"]+)"/;
const OPENAI_NATIVE_FINISH_REASON_PATTERN = /"native_finish_reason"\s*:\s*"([^"]+)"/;
const OPENAI_REASONING_TOKENS_PATTERN = /"reasoning_tokens"\s*:\s*(\d+)/;
const OPENAI_HAS_LOGPROBS_PATTERN = /"logprobs"\s*:\s*(?:null|{)/;
const OPENAI_REFUSAL_PATTERN = /"refusal"\s*:\s*(?:null|"([^"]*)")/;
const OPENAI_REASONING_PATTERN = /"reasoning"\s*:\s*(?:null|"([^"]*)")/;

// Anthropic patterns
const ANTHROPIC_ID_PATTERN = /"id"\s*:\s*"([^"]+)"/;
const ANTHROPIC_MODEL_PATTERN = /"model"\s*:\s*"([^"]+)"/;
const ANTHROPIC_STOP_REASON_PATTERN = /"stop_reason"\s*:\s*(?:null|"([^"]+)")/;
const ANTHROPIC_STOP_SEQUENCE_PATTERN = /"stop_sequence"\s*:\s*(?:null|"([^"]+)")/;

// Token usage patterns (used by both OpenAI and Anthropic)
const INPUT_TOKENS_PATTERN = /"input_tokens"\s*:\s*(\d+)/;
const OUTPUT_TOKENS_PATTERN = /"output_tokens"\s*:\s*(\d+)/;
const CACHE_CREATION_INPUT_TOKENS_PATTERN = /"cache_creation_input_tokens"\s*:\s*(\d+)/;
const CACHE_READ_INPUT_TOKENS_PATTERN = /"cache_read_input_tokens"\s*:\s*(\d+)/;

/**
 * Extracts OpenAI-compatible metadata from SSE event data string.
 * Designed to work incrementally - can be called multiple times with different event data
 * to accumulate metadata across the stream.
 */
export function extractOpenAIMetadata(
  data: string,
  existing: Partial<LLMResponseMetadata> = {},
): Partial<LLMResponseMetadata> {
  const metadata: Partial<LLMResponseMetadata> = { ...existing };

  // Extract root-level fields (id, model, object, created)
  const idMatch = OPENAI_ID_PATTERN.exec(data);
  if (idMatch && !metadata.id) {
    metadata.id = idMatch[1];
  }

  const modelMatch = OPENAI_MODEL_PATTERN.exec(data);
  if (modelMatch && !metadata.model) {
    metadata.model = modelMatch[1];
  }

  const objectMatch = OPENAI_OBJECT_PATTERN.exec(data);
  if (objectMatch && !metadata.object) {
    metadata.object = objectMatch[1];
  }

  const createdMatch = OPENAI_CREATED_PATTERN.exec(data);
  if (createdMatch?.[1] && !metadata.created) {
    metadata.created = parseInt(createdMatch[1], 10);
  }

  // Extract finish_reason from choices array (may appear in multiple events)
  const finishReasonMatch = OPENAI_FINISH_REASON_PATTERN.exec(data);
  if (finishReasonMatch && !metadata.finishReason) {
    metadata.finishReason = finishReasonMatch[1];
  }

  const nativeFinishReasonMatch = OPENAI_NATIVE_FINISH_REASON_PATTERN.exec(data);
  if (nativeFinishReasonMatch && !metadata.nativeFinishReason) {
    metadata.nativeFinishReason = nativeFinishReasonMatch[1];
  }

  // Extract reasoning tokens (may be nested in completion_tokens_details)
  const reasoningTokensMatch = OPENAI_REASONING_TOKENS_PATTERN.exec(data);
  if (reasoningTokensMatch?.[1] && !metadata.reasoningTokens) {
    metadata.reasoningTokens = parseInt(reasoningTokensMatch[1], 10);
  }

  // Check for logprobs (boolean - just check if field exists and is not null)
  if (OPENAI_HAS_LOGPROBS_PATTERN.test(data) && metadata.hasLogprobs === undefined) {
    metadata.hasLogprobs = true;
  }

  // Extract refusal (may be null or a string)
  const refusalMatch = OPENAI_REFUSAL_PATTERN.exec(data);
  if (refusalMatch && metadata.refusal === undefined) {
    metadata.refusal = refusalMatch[1] ?? null;
  }

  // Extract reasoning (may be null or a string)
  const reasoningMatch = OPENAI_REASONING_PATTERN.exec(data);
  if (reasoningMatch && metadata.reasoning === undefined) {
    metadata.reasoning = reasoningMatch[1] ?? null;
  }

  return metadata;
}

/**
 * Extracts Anthropic metadata from SSE event data string.
 * Designed to work incrementally - can be called multiple times with different event data
 * to accumulate metadata across the stream.
 */
export function extractAnthropicMetadata(
  data: string,
  existing: Partial<LLMResponseMetadata> = {},
): Partial<LLMResponseMetadata> {
  const metadata: Partial<LLMResponseMetadata> = { ...existing };

  // Extract message ID (from message_start event)
  const idMatch = ANTHROPIC_ID_PATTERN.exec(data);
  if (idMatch && !metadata.id) {
    metadata.id = idMatch[1];
  }

  // Extract model (from message_start event)
  const modelMatch = ANTHROPIC_MODEL_PATTERN.exec(data);
  if (modelMatch && !metadata.object) {
    // Store model in object field for consistency with other providers
    metadata.object = modelMatch[1];
  }

  // Extract stop_reason (from message_delta or message_stop)
  const stopReasonMatch = ANTHROPIC_STOP_REASON_PATTERN.exec(data);
  if (stopReasonMatch && !metadata.stopReason) {
    // stopReasonMatch[1] will be undefined if the value is null in JSON
    // We store undefined (not null) to match the type definition
    metadata.stopReason = stopReasonMatch[1];
  }

  // Extract stop_sequence (from message_delta or message_stop)
  const stopSequenceMatch = ANTHROPIC_STOP_SEQUENCE_PATTERN.exec(data);
  if (stopSequenceMatch && !metadata.stopSequence) {
    // stopSequenceMatch[1] will be undefined if the value is null in JSON
    // We store undefined (not null) to match the type definition
    metadata.stopSequence = stopSequenceMatch[1];
  }

  return metadata;
}

/**
 * Extracts metadata from SSE event data string, detecting provider automatically.
 * Checks for provider-specific patterns and applies appropriate extraction.
 */
export function extractMetadataFromSSEData(
  data: string,
  existing: Partial<LLMResponseMetadata> = {},
): Partial<LLMResponseMetadata> {
  // Try OpenAI-compatible patterns first (more common)
  const openaiMetadata = extractOpenAIMetadata(data, existing);

  // Check for OpenAI-specific fields (object or finish_reason indicate OpenAI-compatible)
  // We check these instead of just 'id' because both providers use 'id'
  if (openaiMetadata.object || openaiMetadata.finishReason || openaiMetadata.nativeFinishReason) {
    return openaiMetadata;
  }

  // Otherwise try Anthropic patterns
  // Anthropic responses have 'model' instead of 'object', and 'stop_reason' instead of 'finish_reason'
  const anthropicMetadata = extractAnthropicMetadata(data, existing);

  // If we found Anthropic-specific fields, use that
  // Otherwise, merge both (OpenAI might have extracted id, Anthropic might add model/stop_reason)
  if (anthropicMetadata.stopReason || anthropicMetadata.stopSequence) {
    return { ...openaiMetadata, ...anthropicMetadata };
  }

  // Return merged metadata (OpenAI might have extracted some fields)
  return { ...openaiMetadata, ...anthropicMetadata };
}

/**
 * Extracts token usage from SSE event data string using regex.
 * Returns token counts for input_tokens, output_tokens, and cache-related tokens.
 */
export function extractTokenUsageFromSSEData(data: string): {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
} {
  const usage: {
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
  } = {};

  const inputTokensMatch = INPUT_TOKENS_PATTERN.exec(data);
  if (inputTokensMatch?.[1]) {
    usage.input_tokens = parseInt(inputTokensMatch[1], 10);
  }

  const outputTokensMatch = OUTPUT_TOKENS_PATTERN.exec(data);
  if (outputTokensMatch?.[1]) {
    usage.output_tokens = parseInt(outputTokensMatch[1], 10);
  }

  const cacheCreationMatch = CACHE_CREATION_INPUT_TOKENS_PATTERN.exec(data);
  if (cacheCreationMatch?.[1]) {
    usage.cache_creation_input_tokens = parseInt(cacheCreationMatch[1], 10);
  }

  const cacheReadMatch = CACHE_READ_INPUT_TOKENS_PATTERN.exec(data);
  if (cacheReadMatch?.[1]) {
    usage.cache_read_input_tokens = parseInt(cacheReadMatch[1], 10);
  }

  return usage;
}

/**
 * Extracts metadata from a full response body string (non-streaming).
 * Uses the same regex patterns but searches the entire response body.
 */
export function extractMetadataFromResponseBody(
  responseBody: string,
): Partial<LLMResponseMetadata> {
  // Use the same logic as SSE data extraction
  return extractMetadataFromSSEData(responseBody);
}
