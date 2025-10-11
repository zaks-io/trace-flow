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
  firstTokenReceived?: number;
  responseComplete: number;
}

export interface LLMTokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cached?: boolean;
}

export interface LLMError {
  type?: string;
  message?: string;
  code?: string;
}

export interface SSEMessageTiming {
  messageStart?: number;
  messageStop?: number;
  contentBlockStart?: number;
  firstDelta?: number;
}

export interface SSEMetadata {
  usage?: {
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
  };
  finalUsage?: {
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
  };
}

export interface QueueMessage {
  requestId: string;
  targetUrl: string;
  request: LLMRequest;
  response: LLMResponse;
  requestBodyKey: string;
  responseBodyKey: string;
  timing: LLMTiming;
  tokens?: LLMTokenUsage;
  error?: LLMError;
  traceId?: string;
  parentSpanId?: string;
  sseMessageTiming?: SSEMessageTiming;
  sseMetadata?: SSEMetadata;
}
