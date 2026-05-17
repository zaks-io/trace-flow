/**
 * OTel GenAI semantic conventions used across Trace Flow. Single source of truth
 * for attribute and span-name strings. Writers (proxy-consumer) and readers
 * (packages/spans, web, MCP) all import from here so renames can't drift.
 *
 * Tinybird `.pipe` SQL strings hardcode the same values and aren't compile-time
 * checked. The sqlConsistency test in this package asserts every TS constant has
 * a matching SQL string and vice versa, guarding against silent MV drift.
 */

export const GEN_AI = {
  SYSTEM: 'gen_ai.system',
  REQUEST_ID: 'gen_ai.request_id',
  REQUEST_MODEL: 'gen_ai.request.model',
  RESPONSE_MODEL: 'gen_ai.response.model',
  RESPONSE_ID: 'gen_ai.response_id',
  RESPONSE_OBJECT: 'gen_ai.response_object',
  RESPONSE_CREATED: 'gen_ai.response_created',
  OPERATION_NAME: 'gen_ai.operation.name',
  STREAMING: 'gen_ai.streaming',
  RESPONSE_STREAMING: 'gen_ai.response.streaming',
  FINISH_REASON: 'gen_ai.finish_reason',
  NATIVE_FINISH_REASON: 'gen_ai.native_finish_reason',
  STOP_REASON: 'gen_ai.stop_reason',
  STOP_SEQUENCE: 'gen_ai.stop_sequence',
  HAS_LOGPROBS: 'gen_ai.has_logprobs',
  HAS_REFUSAL: 'gen_ai.has_refusal',
  HAS_REASONING: 'gen_ai.has_reasoning',
  REASONING_TOKENS: 'gen_ai.reasoning_tokens',
  TOKENS_PER_SECOND: 'gen_ai.tokens_per_second',
  SERVER_TTFT: 'gen_ai.server.time_to_first_token',
  ORIGINAL_TRACE_ID: 'gen_ai.original_trace_id',
  MESSAGE_INDEX: 'gen_ai.message.index',
  MESSAGE_ROLE: 'gen_ai.message.role',
  CONTENT_TYPE: 'gen_ai.content.type',
  TOOL_ID: 'gen_ai.tool.id',
  TOOL_NAME: 'gen_ai.tool.name',
} as const;

export const GEN_AI_USAGE = {
  INPUT_TOKENS: 'gen_ai.usage.input_tokens',
  INPUT_TOKENS_UNCACHED: 'gen_ai.usage.input_tokens_uncached',
  OUTPUT_TOKENS: 'gen_ai.usage.output_tokens',
  REASONING_TOKENS: 'gen_ai.usage.reasoning_tokens',
  CACHE_READ_INPUT_TOKENS: 'gen_ai.usage.cache_read_input_tokens',
  CACHE_CREATION_INPUT_TOKENS: 'gen_ai.usage.cache_creation_input_tokens',
  CACHE_CREATION_5M_INPUT_TOKENS: 'gen_ai.usage.cache_creation_5m_input_tokens',
  CACHE_CREATION_1H_INPUT_TOKENS: 'gen_ai.usage.cache_creation_1h_input_tokens',
} as const;

export const GEN_AI_COST = {
  INPUT: 'gen_ai.cost.input',
  OUTPUT: 'gen_ai.cost.output',
  TOTAL: 'gen_ai.cost.total',
  CACHE_READ: 'gen_ai.cost.cache_read',
  CACHE_CREATION: 'gen_ai.cost.cache_creation',
  PROMPT_BASELINE: 'gen_ai.cost.prompt_baseline',
  CACHE_IMPACT: 'gen_ai.cost.cache_impact',
  REASONING: 'gen_ai.cost.reasoning',
  UPSTREAM: 'gen_ai.cost.upstream',
} as const;

export const TRACE_FLOW = {
  SOURCE: 'trace_flow.source',
  PROXY_OVERHEAD_MS: 'trace_flow.proxy_overhead_ms',
  UPSTREAM_TTFB_MS: 'trace_flow.upstream_ttfb_ms',
} as const;

export const ERROR_ATTRS = {
  TYPE: 'error.type',
  CODE: 'error.code',
} as const;

export const HTTP = {
  URL: 'http.url',
  RESPONSE_STATUS_CODE: 'http.response.status_code',
} as const;

export const SOURCE_PROXY = 'proxy';

export const EVENT_NAMES = {
  INPUT_SYSTEM: 'input.system',
  OUTPUT_TIME_TO_FIRST_TOKEN: 'output.time_to_first_token',
  TOOL_CALL_START: 'tool_call.start',
  TOOL_CALL_END: 'tool_call.end',
} as const;

export function outputEventName(blockType: string): string {
  return `output.${blockType}`;
}
export function inputEventName(blockType: string): string {
  return `input.${blockType}`;
}

export const SPAN_NAME_PREFIXES = {
  RESPONSE: 'gen_ai.response.',
  TOOL_EXECUTION: 'gen_ai.tool.execution',
} as const;

export const SPAN_NAMES = {
  TOOL_EXECUTION: SPAN_NAME_PREFIXES.TOOL_EXECUTION,
  /**
   * OTel GenAI convention: `gen_ai.response.{type}[.{N}]` for streamed content
   * blocks. Pass `n` to opt into numbering (caller decides — typically when more
   * than one block of the same type exists in the response). Omit for unnumbered.
   */
  responseFor(outputType: string, n?: number): string {
    return n === undefined
      ? `${SPAN_NAME_PREFIXES.RESPONSE}${outputType}`
      : `${SPAN_NAME_PREFIXES.RESPONSE}${outputType}.${n}`;
  },
  /** OTel GenAI convention: root span name is `{operation} {model}` (or just `{operation}`). */
  rootFor(operation: string, model?: string): string {
    return model ? `${operation} ${model}` : operation;
  },
} as const;

export const SPAN_KIND = {
  CLIENT: 'SPAN_KIND_CLIENT',
  INTERNAL: 'SPAN_KIND_INTERNAL',
} as const;

export const STATUS_CODE = {
  OK: 'STATUS_CODE_OK',
  ERROR: 'STATUS_CODE_ERROR',
} as const;

/**
 * Every attribute key string the Trace Flow code base writes. Used by the
 * sqlConsistency test to find SQL extractions that lack a TS counterpart.
 */
export const ALL_ATTRIBUTE_KEYS: readonly string[] = [
  ...Object.values(GEN_AI),
  ...Object.values(GEN_AI_USAGE),
  ...Object.values(GEN_AI_COST),
  ...Object.values(TRACE_FLOW),
  ...Object.values(ERROR_ATTRS),
  ...Object.values(HTTP),
];
