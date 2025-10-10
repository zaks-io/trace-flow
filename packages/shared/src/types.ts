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
}
