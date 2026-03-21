export interface LLMRequest {
  id: string;
  provider: string;
  model: string;
  messages: unknown[];
  timestamp: number;
}

export interface LLMResponse {
  id: string;
  provider: string;
  status: number;
  timestamp: number;
  latency: number;
}

export interface LLMTiming {
  requestStart: number;
  requestSent: number;
  responseReceived: number;
  firstTokenReceived?: number;
  responseComplete: number;
}

export interface LLMTokenUsage {
  promptTokens?: number;
  uncachedInputTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  cacheCreation5mTokens?: number;
  cacheCreation1hTokens?: number;
  upstreamCost?: number;
}

export interface LLMResponseMetadata {
  id?: string;
  model?: string;
  object?: string;
  created?: number;
  finishReason?: string;
  nativeFinishReason?: string;
  stopReason?: string | null; // Anthropic
  stopSequence?: string | null; // Anthropic
  hasLogprobs?: boolean;
  refusal?: string | null;
  reasoning?: string | null;
  reasoningTokens?: number;
}

export interface LLMError {
  type?: string;
  message?: string;
  code?: string;
}

/**
 * Content block from request body (input messages).
 */
export interface InputContentBlock {
  index: number;
  type: 'text' | 'tool_use' | 'tool_result' | 'tool_call' | 'image';
  toolUseId?: string;
  toolName?: string;
  toolResultId?: string;
  toolCallId?: string;
}

/**
 * Input message parsed from request body.
 */
export interface InputMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  index: number;
  contentBlocks: InputContentBlock[];
}

/**
 * Tool call start info returned from ToolCallTracker DO.
 */
export interface ToolCallStart {
  toolName: string;
  startTimestamp: number;
  traceId: string;
}

/**
 * Tool execution info for cross-request tool duration tracking.
 * Created when a tool_result is received that matches a previous tool_use.
 */
export interface ToolExecution {
  toolUseId: string;
  toolName: string;
  startTimestamp: number;
  endTimestamp: number;
  originalTraceId: string;
}
