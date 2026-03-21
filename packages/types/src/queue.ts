import type { SubscriptionTier } from './billing';
import type {
  LLMRequest,
  LLMResponse,
  LLMTiming,
  LLMTokenUsage,
  LLMError,
  LLMResponseMetadata,
  InputMessage,
  ToolExecution,
} from './llm';
import type { SSEStreamData } from './sse';

export interface QueueMessage {
  requestId: string;
  apiKey: string;
  targetUrl: string;
  request: LLMRequest;
  response: LLMResponse;
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
  TierAtIngestion: string;
  RetentionExpiresAt: number;
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
