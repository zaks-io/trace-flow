import type {
  QueueMessage,
  TinybirdTrace,
  InputMessage,
  AnthropicContentBlock,
  ToolExecution,
} from '@trace-flow/types';
import { generateSpanId } from '@trace-flow/utils';

/**
 * Transforms queue messages into OpenTelemetry traces for Tinybird storage.
 *
 * Creates a trace hierarchy:
 * - Root span: Overall AI request with status, model, provider metadata
 *   - For streaming: includes ai.time_to_first_token_ms attribute
 *
 * For SSE streaming responses:
 * - Content block spans: Individual thinking, text, tool_use spans as siblings
 *
 * For non-streaming responses:
 * - Root span only (no additional timing spans)
 */
export function buildTraces(data: QueueMessage): TinybirdTrace[] {
  const traces: TinybirdTrace[] = [];
  const traceId = data.traceId ?? data.requestId;
  const serviceName = 'llm-observability';

  const rootSpan: TinybirdTrace = {
    ReceivedAt: data.receivedAt,
    Timestamp: data.timing.requestStart * 1_000_000,
    TraceId: traceId,
    SpanId: generateSpanId(),
    ParentSpanId: data.parentSpanId ?? '',
    TraceState: '',
    SpanName: 'ai.request',
    SpanKind: 'SPAN_KIND_CLIENT',
    ServiceName: serviceName,
    ResourceAttributes: {
      'service.name': serviceName,
    },
    SpanAttributes: {
      'ai.request_id': data.requestId,
      'ai.provider': data.request.provider,
      'ai.model': data.request.model,
      'ai.target_url': data.targetUrl,
      'http.status_code': String(data.response.status),
    },
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
  };

  if (data.tokens) {
    if (data.tokens.promptTokens) {
      rootSpan.SpanAttributes['ai.tokens.prompt'] = String(data.tokens.promptTokens);
    }
    if (data.tokens.completionTokens) {
      rootSpan.SpanAttributes['ai.tokens.completion'] = String(data.tokens.completionTokens);
    }
    if (data.tokens.totalTokens) {
      rootSpan.SpanAttributes['ai.tokens.total'] = String(data.tokens.totalTokens);
    }
    if (data.tokens.cached !== undefined) {
      rootSpan.SpanAttributes['ai.cached'] = String(data.tokens.cached);
    }
    if (data.tokens.reasoningTokens !== undefined) {
      rootSpan.SpanAttributes['ai.reasoning_tokens'] = String(data.tokens.reasoningTokens);
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
      rootSpan.SpanAttributes['ai.response_id'] = meta.id;
    }
    if (meta.model) {
      // Update model from response if available (overrides request model)
      rootSpan.SpanAttributes['ai.model'] = meta.model;
    }
    if (meta.object) {
      rootSpan.SpanAttributes['ai.response_object'] = meta.object;
    }
    if (meta.created !== undefined) {
      rootSpan.SpanAttributes['ai.response_created'] = String(meta.created);
    }
    if (meta.finishReason) {
      rootSpan.SpanAttributes['ai.finish_reason'] = meta.finishReason;
    }
    if (meta.nativeFinishReason) {
      rootSpan.SpanAttributes['ai.native_finish_reason'] = meta.nativeFinishReason;
    }
    if (meta.stopReason) {
      rootSpan.SpanAttributes['ai.stop_reason'] = meta.stopReason;
    }
    if (meta.stopSequence) {
      rootSpan.SpanAttributes['ai.stop_sequence'] = meta.stopSequence;
    }
    if (meta.hasLogprobs !== undefined) {
      rootSpan.SpanAttributes['ai.has_logprobs'] = String(meta.hasLogprobs);
    }
    if (meta.reasoningTokens !== undefined) {
      rootSpan.SpanAttributes['ai.reasoning_tokens'] = String(meta.reasoningTokens);
    }
    if (meta.refusal !== undefined) {
      rootSpan.SpanAttributes['ai.has_refusal'] = String(meta.refusal !== null);
    }
    if (meta.reasoning !== undefined) {
      rootSpan.SpanAttributes['ai.has_reasoning'] = String(meta.reasoning !== null);
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

    // Add TTFT attribute to root span (measures user-perceived time to first token)
    if (firstContentDelta) {
      rootSpan.SpanAttributes['ai.time_to_first_token_ms'] = String(
        firstContentDelta.timestamp - data.timing.requestStart,
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
      );
      traces.push(...contentBlockSpans);
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
      SpanName: 'ai.response.text',
      SpanKind: 'SPAN_KIND_INTERNAL',
      ServiceName: serviceName,
      ResourceAttributes: {
        'service.name': serviceName,
      },
      SpanAttributes: {
        'ai.request_id': data.requestId,
        'ai.response.streaming': 'false',
        'ai.content.type': 'text',
        'ai.message.index': String(data.inputMessages?.length ?? 0),
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
    };
    traces.push(responseSpan);
  }

  // Create input message spans
  if (data.inputMessages && data.inputMessages.length > 0) {
    const inputSpans = buildInputMessageSpans(
      data.inputMessages,
      data,
      rootSpan.SpanId,
      traceId,
      serviceName,
    );
    traces.push(...inputSpans);
  }

  // Create tool execution spans (cross-request tool durations)
  if (data.toolExecutions && data.toolExecutions.length > 0) {
    const toolSpans = buildToolExecutionSpans(
      data.toolExecutions,
      data,
      rootSpan.SpanId,
      traceId,
      serviceName,
    );
    traces.push(...toolSpans);
  }

  return traces;
}

/**
 * Creates spans for input messages from the request body.
 * These are marker spans (duration: 0) at the request start time.
 */
function buildInputMessageSpans(
  inputMessages: InputMessage[],
  data: QueueMessage,
  parentSpanId: string,
  traceId: string,
  serviceName: string,
): TinybirdTrace[] {
  const spans: TinybirdTrace[] = [];

  for (const message of inputMessages) {
    // Determine span name based on role and content
    // Use ai.request.{role} pattern to clearly indicate these are INPUT spans
    let spanName: string;
    const attributes: Record<string, string> = {
      'ai.request_id': data.requestId,
      'ai.message.role': message.role,
      'ai.message.index': String(message.index),
    };

    if (message.role === 'system') {
      spanName = 'ai.request.system';
    } else if (message.role === 'user') {
      // Check if this is a tool result message
      const hasToolResult = message.contentBlocks.some((b) => b.type === 'tool_result');
      if (hasToolResult) {
        spanName = 'ai.request.tool_result';
        const toolResultBlock = message.contentBlocks.find((b) => b.type === 'tool_result');
        if (toolResultBlock?.toolResultId) {
          attributes['ai.tool.id'] = toolResultBlock.toolResultId;
        }
      } else {
        spanName = 'ai.request.user';
      }
    } else if (message.role === 'assistant') {
      spanName = 'ai.request.assistant';
    } else {
      spanName = `ai.request.${message.role}`;
    }

    const span: TinybirdTrace = {
      ReceivedAt: data.receivedAt,
      Timestamp: data.timing.requestStart * 1_000_000,
      TraceId: traceId,
      SpanId: generateSpanId(),
      ParentSpanId: parentSpanId,
      TraceState: '',
      SpanName: spanName,
      SpanKind: 'SPAN_KIND_INTERNAL',
      ServiceName: serviceName,
      ResourceAttributes: { 'service.name': serviceName },
      SpanAttributes: attributes,
      Duration: 0, // Input spans are instantaneous markers
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
    };

    spans.push(span);
  }

  return spans;
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

    // Build span name: ai.response.{type} or ai.response.{type}.{N} if multiple
    let spanName = `ai.response.${block.type}`;
    if (totalOfType > 1) {
      spanName = `${spanName}.${occurrenceNum}`;
    }

    const attributes: Record<string, string> = {
      'ai.request_id': data.requestId,
      // Unified message index: inputMessages come first, then content blocks
      // Content blocks use: inputMessageCount + (messageIndex * 100) + blockIndex
      'ai.message.index': String(inputMessageCount + messageIndex * 100 + block.index),
      'ai.content.type': block.type,
    };

    if (block.type === 'tool_use') {
      if (block.toolUseId) {
        attributes['ai.tool.id'] = block.toolUseId;
      }
      if (block.toolName) {
        attributes['ai.tool.name'] = block.toolName;
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
    };

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
): TinybirdTrace[] {
  const spans: TinybirdTrace[] = [];

  for (const execution of toolExecutions) {
    const attributes: Record<string, string> = {
      'ai.request_id': data.requestId,
      'ai.tool.id': execution.toolUseId,
      'ai.tool.name': execution.toolName,
      'ai.original_trace_id': execution.originalTraceId,
    };

    const span: TinybirdTrace = {
      ReceivedAt: data.receivedAt,
      Timestamp: execution.startTimestamp * 1_000_000,
      TraceId: traceId, // Use current trace ID (where tool_result was received)
      SpanId: generateSpanId(),
      ParentSpanId: parentSpanId,
      TraceState: '',
      SpanName: 'ai.tool.execution',
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
    };

    spans.push(span);
  }

  return spans;
}
