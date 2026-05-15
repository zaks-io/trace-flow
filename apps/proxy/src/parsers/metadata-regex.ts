import type { LLMResponseMetadata } from '@trace-flow/types';

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

// Google patterns (Gemini API)
const GOOGLE_FINISH_REASON_PATTERN = /"finishReason"\s*:\s*"([^"]+)"/;
const GOOGLE_MODEL_VERSION_PATTERN = /"modelVersion"\s*:\s*"([^"]+)"/;
const GOOGLE_RESPONSE_ID_PATTERN = /"responseId"\s*:\s*"([^"]+)"/;
// Google token patterns for usageMetadata
const GOOGLE_PROMPT_TOKEN_COUNT_PATTERN = /"promptTokenCount"\s*:\s*(\d+)/;
const GOOGLE_CANDIDATES_TOKEN_COUNT_PATTERN = /"candidatesTokenCount"\s*:\s*(\d+)/;
const GOOGLE_CACHED_TOKEN_COUNT_PATTERN = /"cachedContentTokenCount"\s*:\s*(\d+)/;
const GOOGLE_TOTAL_TOKEN_COUNT_PATTERN = /"totalTokenCount"\s*:\s*(\d+)/;
const GOOGLE_THOUGHTS_TOKEN_COUNT_PATTERN = /"thoughtsTokenCount"\s*:\s*(\d+)/;

// Token usage patterns (used by both OpenAI and Anthropic)
const INPUT_TOKENS_PATTERN = /"input_tokens"\s*:\s*(\d+)/;
const OUTPUT_TOKENS_PATTERN = /"output_tokens"\s*:\s*(\d+)/;
// OpenAI-style naming (used by OpenRouter, OpenAI, Groq)
const PROMPT_TOKENS_PATTERN = /"prompt_tokens"\s*:\s*(\d+)/;
const COMPLETION_TOKENS_PATTERN = /"completion_tokens"\s*:\s*(\d+)/;
const CACHE_CREATION_INPUT_TOKENS_PATTERN = /"cache_creation_input_tokens"\s*:\s*(\d+)/;
const CACHE_READ_INPUT_TOKENS_PATTERN = /"cache_read_input_tokens"\s*:\s*(\d+)/;
const CACHE_WRITE_TOKENS_PATTERN = /"cache_write_tokens"\s*:\s*(\d+)/;
// OpenAI cache field — nested under `prompt_tokens_details` (Chat Completions)
// or `input_tokens_details` (Responses API). Same field name, so this matches both.
const CACHED_TOKENS_PATTERN = /"cached_tokens"\s*:\s*(\d+)/;
const EPHEMERAL_5M_INPUT_TOKENS_PATTERN = /"ephemeral_5m_input_tokens"\s*:\s*(\d+)/;
const EPHEMERAL_1H_INPUT_TOKENS_PATTERN = /"ephemeral_1h_input_tokens"\s*:\s*(\d+)/;
// Scoped to usage context — only matches "cost" that appears after "usage" in the data.
// Prevents false-positives from unrelated "cost" fields in model response content.
const UPSTREAM_COST_PATTERN = /"usage"[\s\S]*?"cost"\s*:\s*([0-9.eE+-]+)/;

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
  if (modelMatch && !metadata.model) {
    metadata.model = modelMatch[1];
  }

  // Extract stop_reason (from message_delta or message_stop)
  const stopReasonMatch = ANTHROPIC_STOP_REASON_PATTERN.exec(data);
  if (stopReasonMatch && !metadata.stopReason) {
    // stopReasonMatch[1] will be undefined if the value is null in JSON
    // We need to explicitly set null when the pattern matched but group 1 is undefined
    metadata.stopReason = stopReasonMatch[1] ?? null;
  }

  // Extract stop_sequence (from message_delta or message_stop)
  const stopSequenceMatch = ANTHROPIC_STOP_SEQUENCE_PATTERN.exec(data);
  if (stopSequenceMatch && !metadata.stopSequence) {
    // stopSequenceMatch[1] will be undefined if the value is null in JSON
    // We need to explicitly set null when the pattern matched but group 1 is undefined
    metadata.stopSequence = stopSequenceMatch[1] ?? null;
  }

  return metadata;
}

/**
 * Extracts Google Gemini metadata from SSE event data or response body.
 * Designed to work incrementally - can be called multiple times with different event data
 * to accumulate metadata across the stream.
 */
export function extractGoogleMetadata(
  data: string,
  existing: Partial<LLMResponseMetadata> = {},
): Partial<LLMResponseMetadata> {
  const metadata: Partial<LLMResponseMetadata> = { ...existing };

  const responseIdMatch = GOOGLE_RESPONSE_ID_PATTERN.exec(data);
  if (responseIdMatch && !metadata.id) {
    metadata.id = responseIdMatch[1];
  }

  const modelVersionMatch = GOOGLE_MODEL_VERSION_PATTERN.exec(data);
  if (modelVersionMatch && !metadata.model) {
    metadata.model = modelVersionMatch[1];
  }

  const finishReasonMatch = GOOGLE_FINISH_REASON_PATTERN.exec(data);
  if (finishReasonMatch && !metadata.finishReason) {
    metadata.finishReason = finishReasonMatch[1];
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

  // Try Google patterns (check for finishReason with camelCase - Google's format)
  const googleMetadata = extractGoogleMetadata(data, existing);
  if (googleMetadata.finishReason || googleMetadata.model) {
    return { ...openaiMetadata, ...googleMetadata };
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
 * Returns token counts for input_tokens, output_tokens, cache-related tokens, and Google-style tokens.
 */
export function extractTokenUsageFromSSEData(data: string): {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_write_tokens?: number;
  cached_tokens?: number;
  ephemeral_5m_input_tokens?: number;
  ephemeral_1h_input_tokens?: number;
  output_tokens?: number;
  reasoning_tokens?: number;
  cost?: number;
  prompt_token_count?: number;
  candidates_token_count?: number;
  cached_content_token_count?: number;
  total_token_count?: number;
  thoughts_token_count?: number;
} {
  const usage: {
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    cache_write_tokens?: number;
    cached_tokens?: number;
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
    output_tokens?: number;
    reasoning_tokens?: number;
    cost?: number;
    prompt_token_count?: number;
    candidates_token_count?: number;
    cached_content_token_count?: number;
    total_token_count?: number;
    thoughts_token_count?: number;
  } = {};

  // OpenAI/Anthropic patterns
  const inputTokensMatch = INPUT_TOKENS_PATTERN.exec(data);
  if (inputTokensMatch?.[1]) {
    usage.input_tokens = parseInt(inputTokensMatch[1], 10);
  }

  const outputTokensMatch = OUTPUT_TOKENS_PATTERN.exec(data);
  if (outputTokensMatch?.[1]) {
    usage.output_tokens = parseInt(outputTokensMatch[1], 10);
  }

  // OpenAI-style prompt_tokens/completion_tokens (fallback when input_tokens/output_tokens absent)
  if (usage.input_tokens === undefined) {
    const promptTokensMatch = PROMPT_TOKENS_PATTERN.exec(data);
    if (promptTokensMatch?.[1]) {
      usage.input_tokens = parseInt(promptTokensMatch[1], 10);
    }
  }
  if (usage.output_tokens === undefined) {
    const completionTokensMatch = COMPLETION_TOKENS_PATTERN.exec(data);
    if (completionTokensMatch?.[1]) {
      usage.output_tokens = parseInt(completionTokensMatch[1], 10);
    }
  }

  const cacheCreationMatch = CACHE_CREATION_INPUT_TOKENS_PATTERN.exec(data);
  if (cacheCreationMatch?.[1]) {
    usage.cache_creation_input_tokens = parseInt(cacheCreationMatch[1], 10);
  }

  const cacheReadMatch = CACHE_READ_INPUT_TOKENS_PATTERN.exec(data);
  if (cacheReadMatch?.[1]) {
    usage.cache_read_input_tokens = parseInt(cacheReadMatch[1], 10);
  }

  const cacheWriteMatch = CACHE_WRITE_TOKENS_PATTERN.exec(data);
  if (cacheWriteMatch?.[1]) {
    usage.cache_write_tokens = parseInt(cacheWriteMatch[1], 10);
  }

  const cachedTokensMatch = CACHED_TOKENS_PATTERN.exec(data);
  if (cachedTokensMatch?.[1]) {
    usage.cached_tokens = parseInt(cachedTokensMatch[1], 10);
  }

  const ephemeral5mMatch = EPHEMERAL_5M_INPUT_TOKENS_PATTERN.exec(data);
  if (ephemeral5mMatch?.[1]) {
    usage.ephemeral_5m_input_tokens = parseInt(ephemeral5mMatch[1], 10);
  }

  const ephemeral1hMatch = EPHEMERAL_1H_INPUT_TOKENS_PATTERN.exec(data);
  if (ephemeral1hMatch?.[1]) {
    usage.ephemeral_1h_input_tokens = parseInt(ephemeral1hMatch[1], 10);
  }

  const reasoningTokensMatch = OPENAI_REASONING_TOKENS_PATTERN.exec(data);
  if (reasoningTokensMatch?.[1]) {
    usage.reasoning_tokens = parseInt(reasoningTokensMatch[1], 10);
  }

  const costMatch = UPSTREAM_COST_PATTERN.exec(data);
  if (costMatch?.[1]) {
    usage.cost = parseFloat(costMatch[1]);
  }

  // Google patterns
  const promptTokenCountMatch = GOOGLE_PROMPT_TOKEN_COUNT_PATTERN.exec(data);
  if (promptTokenCountMatch?.[1]) {
    usage.prompt_token_count = parseInt(promptTokenCountMatch[1], 10);
  }

  const candidatesTokenCountMatch = GOOGLE_CANDIDATES_TOKEN_COUNT_PATTERN.exec(data);
  if (candidatesTokenCountMatch?.[1]) {
    usage.candidates_token_count = parseInt(candidatesTokenCountMatch[1], 10);
  }

  const cachedContentTokenCountMatch = GOOGLE_CACHED_TOKEN_COUNT_PATTERN.exec(data);
  if (cachedContentTokenCountMatch?.[1]) {
    usage.cached_content_token_count = parseInt(cachedContentTokenCountMatch[1], 10);
  }

  const totalTokenCountMatch = GOOGLE_TOTAL_TOKEN_COUNT_PATTERN.exec(data);
  if (totalTokenCountMatch?.[1]) {
    usage.total_token_count = parseInt(totalTokenCountMatch[1], 10);
  }

  const thoughtsTokenCountMatch = GOOGLE_THOUGHTS_TOKEN_COUNT_PATTERN.exec(data);
  if (thoughtsTokenCountMatch?.[1]) {
    usage.thoughts_token_count = parseInt(thoughtsTokenCountMatch[1], 10);
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
