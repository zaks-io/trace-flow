import type { LLMResponseMetadata } from './llm';

export interface SSEEvent {
  type: string;
  timestamp: number;
  data?: string;
}

/**
 * Content block tracking for Anthropic streaming responses.
 * Tracks individual text and tool_use blocks with timing information.
 */
export interface AnthropicContentBlock {
  index: number;
  type: 'text' | 'tool_use' | 'thinking';
  startTimestamp: number;
  stopTimestamp?: number;
  toolUseId?: string;
  toolName?: string;
  thinkingTextLength?: number;
}

export interface SSEMessage {
  messageStart: number;
  messageStop?: number;
  events: SSEEvent[];
  usage?: {
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    cache_write_tokens?: number;
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
    output_tokens?: number;
    reasoning_tokens?: number;
    cost?: number;
    // Google-style token fields (usageMetadata)
    prompt_token_count?: number;
    candidates_token_count?: number;
    cached_content_token_count?: number;
    total_token_count?: number;
    thoughts_token_count?: number;
  };
  metadata?: Partial<LLMResponseMetadata>;
  contentBlocks?: AnthropicContentBlock[];
}

export interface SSEStreamData {
  messages: SSEMessage[];
}
