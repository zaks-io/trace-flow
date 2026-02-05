export type SubscriptionTier = 'hobby' | 'pro';

export const TIER_CONFIG = {
  hobby: { monthlyUnits: 50_000, price: 0, overagePer100k: 0 },
  pro: { monthlyUnits: 100_000, price: 20, overagePer100k: 8 },
} as const;

export const RETENTION_DAYS = {
  hobby: 7,
  pro: 30,
} as const;

export interface SubscriptionKVData {
  tier: SubscriptionTier;
  monthlyUnits: number;
  addonUnits: number;
}

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
  reasoningTokens?: number;
  cachedTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
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

export interface SSEMessage {
  messageStart: number;
  messageStop?: number;
  events: SSEEvent[];
  usage?: {
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    cache_write_tokens?: number;
    output_tokens?: number;
    cost?: number;
    // Google-style token fields (usageMetadata)
    prompt_token_count?: number;
    candidates_token_count?: number;
    cached_content_token_count?: number;
    total_token_count?: number;
  };
  metadata?: Partial<LLMResponseMetadata>;
  contentBlocks?: AnthropicContentBlock[];
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
  traceFlags?: number;
  traceState?: string;
  baggage?: Record<string, string>;
  /** gen_ai.operation.name per OTel GenAI semantic conventions */
  operationName?: string;
  sseStreamData?: SSEStreamData;
  responseMetadata?: Partial<LLMResponseMetadata>;
  receivedAt: number;
  inputMessages?: InputMessage[];
  toolExecutions?: ToolExecution[];
  /** Subscription tier at time of ingestion for retention policy */
  tier?: SubscriptionTier;
  /** Organization ID for tier lookup */
  orgId?: string;
}

export interface TinybirdTrace {
  ReceivedAt: number;
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
  /** Subscription tier at time of ingestion (hobby, pro, unknown) */
  TierAtIngestion?: string;
  /** Nanosecond timestamp when this trace should be deleted */
  RetentionExpiresAt?: number;
}

/**
 * Queue message for OTLP trace ingestion.
 * Contains pre-transformed TinybirdTrace objects ready for insertion.
 */
export interface OTLPQueueMessage {
  type: 'otlp';
  apiKey: string;
  traces: TinybirdTrace[];
  receivedAt: number;
}

/**
 * LLM proxy queue message with optional type discriminator.
 * The type field is optional for backward compatibility with existing messages.
 */
export interface LLMQueueMessage extends QueueMessage {
  type?: 'llm';
}

/**
 * Union type for all queue message types.
 * Use type guard to distinguish between message types.
 */
export type QueueMessageUnion = LLMQueueMessage | OTLPQueueMessage;
