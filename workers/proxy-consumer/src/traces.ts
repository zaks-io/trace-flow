import type {
  QueueMessage,
  TinybirdTrace,
  InputMessage,
  AnthropicContentBlock,
  ToolExecution,
} from '@trace-flow/types';
import { RETENTION_DAYS } from '@trace-flow/types';
import { generateSpanId } from '@trace-flow/utils';
import { type ModelPricing, calculateCost, formatCostAsString } from './pricing';

const NANOSECONDS_PER_DAY = 24 * 60 * 60 * 1_000_000_000;

/**
 * Calculates the retention expiration timestamp based on the subscription tier.
 * Returns a nanosecond timestamp for when the data should be deleted.
 */
function calculateRetentionExpiresAt(receivedAt: number, tier?: string): number {
  const retentionDays = tier === 'pro' ? RETENTION_DAYS.pro : RETENTION_DAYS.hobby;
  return receivedAt + retentionDays * NANOSECONDS_PER_DAY;
}

/**
 * Transforms queue messages into OpenTelemetry traces for Tinybird storage.
 *
 * Creates a trace hierarchy:
 * - Root span: Overall AI request with status, model, provider metadata
 *   - ai.streaming attribute indicates streaming vs non-streaming
 *   - For streaming: ai.time_to_first_token_ms attribute and output.time_to_first_token event
 *
 * For SSE streaming responses:
 * - Content block spans: Individual thinking, text, tool_use spans as siblings
 *
 * For non-streaming responses:
 * - Root span with response span child (no TTFT - not applicable)
 */
export function buildTraces(data: QueueMessage, pricing?: ModelPricing | null): TinybirdTrace[] {
  const traces: TinybirdTrace[] = [];
  const traceId = data.traceId ?? data.requestId;
  const serviceName = 'llm-observability';

  // Calculate retention fields based on tier
  const tierAtIngestion = data.tier ?? 'hobby';
  const retentionExpiresAt = calculateRetentionExpiresAt(data.receivedAt, data.tier);

  // Determine if this is a streaming response
  const isStreaming = Boolean(
    data.sseStreamData?.messages && data.sseStreamData.messages.length > 0,
  );

  // Derive operation name and model for span naming per OTel GenAI semantic conventions
  const operationName = data.operationName ?? 'chat';
  const model =
    data.responseMetadata?.model ?? (data.request.model !== 'unknown' ? data.request.model : '');

  // Build span attributes using OTel GenAI semantic conventions
  const spanAttributes: Record<string, string> = {
    'trace_flow.source': 'proxy',
    'gen_ai.request_id': data.requestId,
    'gen_ai.system': data.request.provider,
    'gen_ai.request.model': data.request.model,
    'http.url': data.targetUrl,
    'http.response.status_code': String(data.response.status),
    'gen_ai.streaming': String(isStreaming),
    'gen_ai.operation.name': operationName,
  };

  // Add W3C baggage entries as span attributes with baggage. prefix
  if (data.baggage) {
    for (const [key, value] of Object.entries(data.baggage)) {
      spanAttributes[`baggage.${key}`] = value;
    }
  }

  // Build span name per OTel GenAI conventions: "{gen_ai.operation.name} {gen_ai.request.model}"
  const spanName = model ? `${operationName} ${model}` : operationName;

  const rootSpan: TinybirdTrace = {
    ReceivedAt: data.receivedAt,
    Timestamp: data.timing.requestStart * 1_000_000,
    TraceId: traceId,
    SpanId: generateSpanId(),
    ParentSpanId: data.parentSpanId ?? '',
    TraceState: data.traceState ?? '',
    SpanName: spanName,
    SpanKind: 'SPAN_KIND_CLIENT',
    ServiceName: serviceName,
    ResourceAttributes: {
      'service.name': serviceName,
    },
    SpanAttributes: spanAttributes,
    Duration: (data.timing.responseComplete - data.timing.requestStart) * 1_000_000,
    StatusCode: data.error ? 'STATUS_CODE_ERROR' : 'STATUS_CODE_OK',
    StatusMessage: data.error?.message ?? '',
    ApiKey: data.apiKey,
    'Events.Timestamp': [],
    'Events.Name': [],
    'Events.Attributes': [],
    'Links.TraceId': [],
    'Links.SpanId': [],
    'Links.TraceState': [],
    'Links.Attributes': [],
    TierAtIngestion: tierAtIngestion,
    RetentionExpiresAt: retentionExpiresAt,
  };

  if (data.tokens) {
    if (data.tokens.promptTokens) {
      rootSpan.SpanAttributes['gen_ai.usage.input_tokens'] = String(data.tokens.promptTokens);
    }
    if (data.tokens.completionTokens) {
      rootSpan.SpanAttributes['gen_ai.usage.output_tokens'] = String(data.tokens.completionTokens);
    }
    if (data.tokens.reasoningTokens !== undefined) {
      rootSpan.SpanAttributes['gen_ai.usage.reasoning_tokens'] = String(
        data.tokens.reasoningTokens,
      );
    }
    if (data.tokens.cacheReadTokens !== undefined) {
      rootSpan.SpanAttributes['gen_ai.usage.cache_read_input_tokens'] = String(
        data.tokens.cacheReadTokens,
      );
    }
    if (data.tokens.cacheCreationTokens !== undefined) {
      rootSpan.SpanAttributes['gen_ai.usage.cache_creation_input_tokens'] = String(
        data.tokens.cacheCreationTokens,
      );
    }
    if (data.tokens.cacheCreation5mTokens !== undefined) {
      rootSpan.SpanAttributes['gen_ai.usage.cache_creation_5m_input_tokens'] = String(
        data.tokens.cacheCreation5mTokens,
      );
    }
    if (data.tokens.cacheCreation1hTokens !== undefined) {
      rootSpan.SpanAttributes['gen_ai.usage.cache_creation_1h_input_tokens'] = String(
        data.tokens.cacheCreation1hTokens,
      );
    }

    // Calculate cost if pricing is available
    if (pricing) {
      const cost = calculateCost(data.tokens, pricing);

      rootSpan.SpanAttributes['gen_ai.cost.input'] = formatCostAsString(cost.inputCostMicrodollars);
      rootSpan.SpanAttributes['gen_ai.cost.output'] = formatCostAsString(
        cost.outputCostMicrodollars,
      );
      rootSpan.SpanAttributes['gen_ai.cost.total'] = formatCostAsString(cost.totalCostMicrodollars);

      if (cost.cacheReadCostMicrodollars > 0) {
        rootSpan.SpanAttributes['gen_ai.cost.cache_read'] = formatCostAsString(
          cost.cacheReadCostMicrodollars,
        );
      }
      if (cost.cacheWriteCostMicrodollars > 0) {
        rootSpan.SpanAttributes['gen_ai.cost.cache_creation'] = formatCostAsString(
          cost.cacheWriteCostMicrodollars,
        );
      }
      if (cost.reasoningCostMicrodollars > 0) {
        rootSpan.SpanAttributes['gen_ai.cost.reasoning'] = formatCostAsString(
          cost.reasoningCostMicrodollars,
        );
      }
    }

    if (data.tokens.upstreamCost !== undefined) {
      rootSpan.SpanAttributes['gen_ai.cost.upstream'] = String(data.tokens.upstreamCost);
    }
  }

  // Calculate TPS using generation duration (first token → complete)
  // This excludes network latency and provider processing time
  if (data.tokens?.completionTokens && data.tokens.completionTokens > 0) {
    const generationStartMs = data.timing.firstTokenReceived ?? data.timing.requestSent;
    const generationDurationMs = data.timing.responseComplete - generationStartMs;

    if (generationDurationMs > 0) {
      const tokensPerSecond = data.tokens.completionTokens / (generationDurationMs / 1000);
      rootSpan.SpanAttributes['gen_ai.tokens_per_second'] = String(tokensPerSecond.toFixed(2));
    }
  }

  if (data.error) {
    if (data.error.type) {
      rootSpan.SpanAttributes['error.type'] = data.error.type;
    }
    if (data.error.code) {
      rootSpan.SpanAttributes['error.code'] = data.error.code;
    }
  }

  // Add response metadata to span attributes
  if (data.responseMetadata) {
    const meta = data.responseMetadata;
    if (meta.id) {
      rootSpan.SpanAttributes['gen_ai.response_id'] = meta.id;
    }
    if (meta.model) {
      rootSpan.SpanAttributes['gen_ai.response.model'] = meta.model;
    }
    if (meta.object) {
      rootSpan.SpanAttributes['gen_ai.response_object'] = meta.object;
    }
    if (meta.created !== undefined) {
      rootSpan.SpanAttributes['gen_ai.response_created'] = String(meta.created);
    }
    if (meta.finishReason) {
      rootSpan.SpanAttributes['gen_ai.finish_reason'] = meta.finishReason;
    }
    if (meta.nativeFinishReason) {
      rootSpan.SpanAttributes['gen_ai.native_finish_reason'] = meta.nativeFinishReason;
    }
    if (meta.stopReason) {
      rootSpan.SpanAttributes['gen_ai.stop_reason'] = meta.stopReason;
    }
    if (meta.stopSequence) {
      rootSpan.SpanAttributes['gen_ai.stop_sequence'] = meta.stopSequence;
    }
    if (meta.hasLogprobs !== undefined) {
      rootSpan.SpanAttributes['gen_ai.has_logprobs'] = String(meta.hasLogprobs);
    }
    if (meta.reasoningTokens !== undefined) {
      rootSpan.SpanAttributes['gen_ai.reasoning_tokens'] = String(meta.reasoningTokens);
    }
    if (meta.refusal !== undefined) {
      rootSpan.SpanAttributes['gen_ai.has_refusal'] = String(meta.refusal !== null);
    }
    if (meta.reasoning !== undefined) {
      rootSpan.SpanAttributes['gen_ai.has_reasoning'] = String(meta.reasoning !== null);
    }
  }

  traces.push(rootSpan);

  // Collect all content blocks from all messages for numbering
  const allContentBlocks: { block: AnthropicContentBlock; messageIndex: number }[] = [];

  if (data.sseStreamData?.messages && data.sseStreamData.messages.length > 0) {
    // Find first content_block_delta across ALL messages for TTFT tracking
    let firstContentDelta: { timestamp: number } | undefined;
    for (const message of data.sseStreamData.messages) {
      const delta = message.events.find((e) => e.type === 'content_block_delta');
      if (delta) {
        firstContentDelta = delta;
        break;
      }
    }

    // Add TTFT attribute and event to root span (measures user-perceived time to first content)
    if (firstContentDelta) {
      const ttftMs = firstContentDelta.timestamp - data.timing.requestStart;
      rootSpan.SpanAttributes['gen_ai.server.time_to_first_token'] = String(ttftMs);

      // Add TTFT event for timeline visualization
      rootSpan['Events.Timestamp'].push(firstContentDelta.timestamp * 1_000_000);
      rootSpan['Events.Name'].push('output.time_to_first_token');
      rootSpan['Events.Attributes'].push(
        JSON.stringify({
          'gen_ai.server.time_to_first_token': String(ttftMs),
        }),
      );
    }

    // Collect content blocks from all messages
    for (const [messageIndex, message] of data.sseStreamData.messages.entries()) {
      if (!message.messageStop) {
        console.warn('Incomplete message detected (no messageStop):', {
          messageIndex,
          traceId,
        });
        continue;
      }

      if (message.contentBlocks && message.contentBlocks.length > 0) {
        for (const block of message.contentBlocks) {
          allContentBlocks.push({ block, messageIndex });
        }
      }
    }

    // Create content block spans as direct children of root span
    if (allContentBlocks.length > 0) {
      const inputMessageCount = data.inputMessages?.length ?? 0;
      const contentBlockSpans = buildContentBlockSpans(
        allContentBlocks,
        data,
        rootSpan.SpanId,
        traceId,
        serviceName,
        inputMessageCount,
        tierAtIngestion,
        retentionExpiresAt,
      );
      traces.push(...contentBlockSpans);

      // Add output events to root span for SSE responses
      const fallbackTimestamp = data.timing.responseComplete * 1_000_000;
      addOutputEvents(rootSpan, allContentBlocks, fallbackTimestamp);
    } else {
      // SSE data exists but no content blocks were parsed - add generic output event
      addNonStreamingOutputEvent(rootSpan, data);
    }
  } else if (data.response.status < 400) {
    // Create response span for non-streaming responses
    // Uses same ai.response.text name as streaming for consistency
    const responseSpan: TinybirdTrace = {
      ReceivedAt: data.receivedAt,
      Timestamp: data.timing.requestSent * 1_000_000,
      TraceId: traceId,
      SpanId: generateSpanId(),
      ParentSpanId: rootSpan.SpanId,
      TraceState: '',
      SpanName: 'gen_ai.response.text',
      SpanKind: 'SPAN_KIND_INTERNAL',
      ServiceName: serviceName,
      ResourceAttributes: {
        'service.name': serviceName,
      },
      SpanAttributes: {
        'gen_ai.request_id': data.requestId,
        'gen_ai.response.streaming': 'false',
        'gen_ai.content.type': 'text',
        'gen_ai.message.index': String(data.inputMessages?.length ?? 0),
      },
      Duration: (data.timing.responseComplete - data.timing.requestSent) * 1_000_000,
      StatusCode: 'STATUS_CODE_OK',
      StatusMessage: '',
      ApiKey: data.apiKey,
      'Events.Timestamp': [],
      'Events.Name': [],
      'Events.Attributes': [],
      'Links.TraceId': [],
      'Links.SpanId': [],
      'Links.TraceState': [],
      'Links.Attributes': [],
      TierAtIngestion: tierAtIngestion,
      RetentionExpiresAt: retentionExpiresAt,
    };
    traces.push(responseSpan);

    // Add output event for non-streaming response
    addNonStreamingOutputEvent(rootSpan, data);
  }

  // Add input message events to root span
  if (data.inputMessages && data.inputMessages.length > 0) {
    addInputMessageEvents(rootSpan, data.inputMessages);
  }

  // Create tool execution spans (cross-request tool durations)
  if (data.toolExecutions && data.toolExecutions.length > 0) {
    const toolSpans = buildToolExecutionSpans(
      data.toolExecutions,
      data,
      rootSpan.SpanId,
      traceId,
      serviceName,
      tierAtIngestion,
      retentionExpiresAt,
    );
    traces.push(...toolSpans);
  }

  return traces;
}

/**
 * Adds input message events to the root span.
 * Events are based on content type for consistency with output events:
 * - input.system - system prompt
 * - input.text - text content from user or assistant
 * - input.tool_result - tool result content
 * - input.tool_use - tool use content (from assistant in history)
 */
function addInputMessageEvents(rootSpan: TinybirdTrace, inputMessages: InputMessage[]): void {
  const requestTimestamp = rootSpan.Timestamp;

  for (const message of inputMessages) {
    // System messages are treated as a special content type
    if (message.role === 'system') {
      rootSpan['Events.Timestamp'].push(requestTimestamp);
      rootSpan['Events.Name'].push('input.system');
      rootSpan['Events.Attributes'].push(
        JSON.stringify({
          'gen_ai.message.role': message.role,
          'gen_ai.message.index': String(message.index),
        }),
      );
      continue;
    }

    // For user/assistant messages, create events based on content block types
    for (const block of message.contentBlocks) {
      const attributes: Record<string, string> = {
        'gen_ai.message.role': message.role,
        'gen_ai.message.index': String(message.index),
        'gen_ai.content.type': block.type,
      };

      let eventName: string;

      if (block.type === 'tool_result') {
        eventName = 'input.tool_result';
        if (block.toolResultId) {
          attributes['gen_ai.tool.id'] = block.toolResultId;
        }
      } else if (block.type === 'tool_use' || block.type === 'tool_call') {
        eventName = 'input.tool_use';
        if (block.toolUseId) {
          attributes['gen_ai.tool.id'] = block.toolUseId;
        }
        if (block.toolName) {
          attributes['gen_ai.tool.name'] = block.toolName;
        }
      } else {
        // text, image, or other content types
        eventName = `input.${block.type}`;
      }

      rootSpan['Events.Timestamp'].push(requestTimestamp);
      rootSpan['Events.Name'].push(eventName);
      rootSpan['Events.Attributes'].push(JSON.stringify(attributes));
    }
  }
}

/**
 * Adds output events to the root span for SSE streaming responses.
 * Events capture each content block type (text, thinking, tool_use).
 */
function addOutputEvents(
  rootSpan: TinybirdTrace,
  contentBlocks: { block: AnthropicContentBlock; messageIndex: number }[],
  fallbackTimestamp: number,
): void {
  for (const { block } of contentBlocks) {
    const eventName = `output.${block.type}`;
    const attributes: Record<string, string> = {
      'gen_ai.content.type': block.type,
      'gen_ai.message.index': String(block.index),
    };

    if (block.type === 'tool_use') {
      if (block.toolUseId) attributes['gen_ai.tool.id'] = block.toolUseId;
      if (block.toolName) attributes['gen_ai.tool.name'] = block.toolName;
    }

    // Use block's stop timestamp if available, otherwise use fallback (response complete time)
    const timestamp = block.stopTimestamp ? block.stopTimestamp * 1_000_000 : fallbackTimestamp;
    rootSpan['Events.Timestamp'].push(timestamp);
    rootSpan['Events.Name'].push(eventName);
    rootSpan['Events.Attributes'].push(JSON.stringify(attributes));
  }
}

/**
 * Adds output event to the root span for non-streaming responses.
 */
function addNonStreamingOutputEvent(rootSpan: TinybirdTrace, data: QueueMessage): void {
  const attributes: Record<string, string> = {
    'gen_ai.content.type': 'text',
    'gen_ai.response.streaming': 'false',
  };

  rootSpan['Events.Timestamp'].push(data.timing.responseComplete * 1_000_000);
  rootSpan['Events.Name'].push('output.text');
  rootSpan['Events.Attributes'].push(JSON.stringify(attributes));
}

/**
 * Creates spans for content blocks from SSE streaming responses.
 * These capture timing for individual thinking, text, and tool_use blocks.
 * Spans are numbered when there are multiple of the same type.
 * Uses ai.response.{type} pattern to clearly indicate these are OUTPUT spans.
 */
function buildContentBlockSpans(
  contentBlocks: { block: AnthropicContentBlock; messageIndex: number }[],
  data: QueueMessage,
  parentSpanId: string,
  traceId: string,
  serviceName: string,
  inputMessageCount: number,
  tierAtIngestion: string,
  retentionExpiresAt: number,
): TinybirdTrace[] {
  const spans: TinybirdTrace[] = [];

  // Count occurrences of each type for numbering
  const typeCounts: Record<string, number> = {};
  const typeOccurrences: Record<string, number> = {};

  // First pass: count total occurrences of each type
  for (const { block } of contentBlocks) {
    if (block.stopTimestamp) {
      typeCounts[block.type] = (typeCounts[block.type] ?? 0) + 1;
    }
  }

  // Second pass: create spans with numbering
  for (const { block, messageIndex } of contentBlocks) {
    // Skip incomplete blocks
    if (!block.stopTimestamp) {
      continue;
    }

    // Track occurrence number for this type
    typeOccurrences[block.type] = (typeOccurrences[block.type] ?? 0) + 1;
    const occurrenceNum = typeOccurrences[block.type];
    const totalOfType = typeCounts[block.type] ?? 1;

    // Build span name: gen_ai.response.{type} or gen_ai.response.{type}.{N} if multiple
    let spanName = `gen_ai.response.${block.type}`;
    if (totalOfType > 1) {
      spanName = `${spanName}.${occurrenceNum}`;
    }

    const attributes: Record<string, string> = {
      'gen_ai.request_id': data.requestId,
      // Unified message index: inputMessages come first, then content blocks
      // Content blocks use: inputMessageCount + (messageIndex * 100) + blockIndex
      'gen_ai.message.index': String(inputMessageCount + messageIndex * 100 + block.index),
      'gen_ai.content.type': block.type,
    };

    if (block.type === 'tool_use') {
      if (block.toolUseId) {
        attributes['gen_ai.tool.id'] = block.toolUseId;
      }
      if (block.toolName) {
        attributes['gen_ai.tool.name'] = block.toolName;
      }
    }

    const span: TinybirdTrace = {
      ReceivedAt: data.receivedAt,
      Timestamp: block.startTimestamp * 1_000_000,
      TraceId: traceId,
      SpanId: generateSpanId(),
      ParentSpanId: parentSpanId,
      TraceState: '',
      SpanName: spanName,
      SpanKind: 'SPAN_KIND_INTERNAL',
      ServiceName: serviceName,
      ResourceAttributes: { 'service.name': serviceName },
      SpanAttributes: attributes,
      Duration: (block.stopTimestamp - block.startTimestamp) * 1_000_000,
      StatusCode: 'STATUS_CODE_OK',
      StatusMessage: '',
      ApiKey: data.apiKey,
      'Events.Timestamp': [],
      'Events.Name': [],
      'Events.Attributes': [],
      'Links.TraceId': [],
      'Links.SpanId': [],
      'Links.TraceState': [],
      'Links.Attributes': [],
      TierAtIngestion: tierAtIngestion,
      RetentionExpiresAt: retentionExpiresAt,
    };

    // Add start/end events for tool_use blocks to track tool call timing
    if (block.type === 'tool_use') {
      const toolId = block.toolUseId ?? '';
      const toolName = block.toolName ?? '';

      // Add start event
      span['Events.Timestamp'].push(block.startTimestamp * 1_000_000);
      span['Events.Name'].push('tool_call.start');
      span['Events.Attributes'].push(
        JSON.stringify({
          'gen_ai.tool.id': toolId,
          'gen_ai.tool.name': toolName,
        }),
      );

      // Add end event
      span['Events.Timestamp'].push(block.stopTimestamp * 1_000_000);
      span['Events.Name'].push('tool_call.end');
      span['Events.Attributes'].push(
        JSON.stringify({
          'gen_ai.tool.id': toolId,
          'gen_ai.tool.name': toolName,
        }),
      );
    }

    spans.push(span);
  }

  return spans;
}

/**
 * Creates spans for tool executions that span multiple requests.
 * These capture the full duration from tool_use output to tool_result input.
 */
function buildToolExecutionSpans(
  toolExecutions: ToolExecution[],
  data: QueueMessage,
  parentSpanId: string,
  traceId: string,
  serviceName: string,
  tierAtIngestion: string,
  retentionExpiresAt: number,
): TinybirdTrace[] {
  const spans: TinybirdTrace[] = [];

  for (const execution of toolExecutions) {
    const attributes: Record<string, string> = {
      'gen_ai.request_id': data.requestId,
      'gen_ai.tool.id': execution.toolUseId,
      'gen_ai.tool.name': execution.toolName,
      'gen_ai.original_trace_id': execution.originalTraceId,
    };

    const span: TinybirdTrace = {
      ReceivedAt: data.receivedAt,
      Timestamp: execution.startTimestamp * 1_000_000,
      TraceId: traceId, // Use current trace ID (where tool_result was received)
      SpanId: generateSpanId(),
      ParentSpanId: parentSpanId,
      TraceState: '',
      SpanName: 'gen_ai.tool.execution',
      SpanKind: 'SPAN_KIND_INTERNAL',
      ServiceName: serviceName,
      ResourceAttributes: { 'service.name': serviceName },
      SpanAttributes: attributes,
      Duration: (execution.endTimestamp - execution.startTimestamp) * 1_000_000,
      StatusCode: 'STATUS_CODE_OK',
      StatusMessage: '',
      ApiKey: data.apiKey,
      'Events.Timestamp': [],
      'Events.Name': [],
      'Events.Attributes': [],
      'Links.TraceId': [execution.originalTraceId], // Link to the trace where tool_use was emitted
      'Links.SpanId': [],
      'Links.TraceState': [],
      'Links.Attributes': [],
      TierAtIngestion: tierAtIngestion,
      RetentionExpiresAt: retentionExpiresAt,
    };

    spans.push(span);
  }

  return spans;
}
