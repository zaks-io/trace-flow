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
  reasoningTokens?: number;
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

export interface SSEEvent {
  type: string;
  timestamp: number;
  data?: string;
}

export interface SSEMessage {
  messageStart: number;
  messageStop?: number;
  events: SSEEvent[];
  usage?: {
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
  };
  metadata?: Partial<LLMResponseMetadata>;
}

export interface SSEStreamData {
  messages: SSEMessage[];
}

export interface QueueMessage {
  requestId: string;
  apiKey: string;
  targetUrl: string;
  request: LLMRequest;
  response: LLMResponse;
  requestBodyKey?: string;
  responseBodyKey?: string;
  timing: LLMTiming;
  tokens?: LLMTokenUsage;
  error?: LLMError;
  truncated?: boolean;
  traceId?: string;
  parentSpanId?: string;
  sseStreamData?: SSEStreamData;
  responseMetadata?: Partial<LLMResponseMetadata>;
}

export interface TinybirdTrace {
  Timestamp: number;
  TraceId: string;
  SpanId: string;
  ParentSpanId: string;
  TraceState: string;
  SpanName: string;
  SpanKind: string;
  ServiceName: string;
  ResourceAttributes: Record<string, string>;
  SpanAttributes: Record<string, string>;
  Duration: number;
  StatusCode: string;
  StatusMessage: string;
  ApiKey: string;
  'Events.Timestamp': number[];
  'Events.Name': string[];
  'Events.Attributes': string[];
  'Links.TraceId': string[];
  'Links.SpanId': string[];
  'Links.TraceState': string[];
  'Links.Attributes': string[];
}
