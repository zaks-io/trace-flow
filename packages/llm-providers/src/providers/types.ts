import type {
  InputMessage,
  LLMResponseMetadata,
  LLMTokenUsage,
  SSEStreamData,
} from '@trace-flow/types';
import type { ProviderId, ProviderTokenSchema } from '../types';

/**
 * A single parsed Server-Sent Events frame. Mirrors the `Event` shape emitted by
 * `eventsource-parser`'s `onEvent` callback — only the bits providers actually
 * use to drive their SSE event handler.
 */
export interface ParsedSSEEvent {
  event?: string;
  data: string;
}

/**
 * The deep module a Provider becomes. One adapter per provider lives under
 * `packages/llm-providers/src/providers/`; callers route through
 * `getProvider(id)` rather than switching on `ProviderId`.
 *
 * Every Provider owns the full per-provider shape: routing config, token schema,
 * request-body parsing, response metadata + token extraction (whole-body and
 * streaming), and SSE event handling. Google additionally exposes
 * `resolveModelFromUrl` because Gemini's embed responses don't carry the model
 * in the body.
 */
export interface Provider {
  readonly id: ProviderId;
  readonly baseUrl: string;
  readonly tokenSchema: ProviderTokenSchema;

  parseRequestBody(body: string): InputMessage[] | null;
  parseResponseMetadata(body: string): Partial<LLMResponseMetadata> | undefined;
  parseResponseTokenUsage(body: string): LLMTokenUsage | undefined;

  handleSSEEvent(event: ParsedSSEEvent, timestamp: number, state: SSEStreamData): void;
  aggregateSSETokens(streamData: SSEStreamData): LLMTokenUsage | undefined;

  resolveModelFromUrl?(targetUrl: string): string | undefined;
}

/**
 * The output of `resolveRoute(path)`. `provider` is the full Provider adapter
 * — proxy code reaches for `route.provider.handleSSEEvent`, `route.provider.id`,
 * etc., without switching on `ProviderId`.
 */
export interface ResolvedRoute {
  provider: Provider;
  targetUrl: string;
}
