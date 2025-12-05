import type { QueueMessage, TinybirdTrace } from '@trace-flow/types';
import { generateSpanId } from '@trace-flow/utils';

/**
 * Transforms queue messages into OpenTelemetry traces for Tinybird storage.
 *
 * Creates a trace hierarchy:
 * - Root span: Overall LLM request with status, model, provider metadata
 *
 * For SSE streaming responses:
 * - TTFT span: Total time to first token from user perspective (requestStart → first content_block_delta)
 * - Message spans: Individual SSE messages with events and token usage
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
    SpanName: 'llm.request',
    SpanKind: 'SPAN_KIND_CLIENT',
    ServiceName: serviceName,
    ResourceAttributes: {
      'service.name': serviceName,
    },
    SpanAttributes: {
      'llm.request_id': data.requestId,
      'llm.provider': data.request.provider,
      'llm.model': data.request.model,
      'llm.target_url': data.targetUrl,
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
      rootSpan.SpanAttributes['llm.tokens.prompt'] = String(data.tokens.promptTokens);
    }
    if (data.tokens.completionTokens) {
      rootSpan.SpanAttributes['llm.tokens.completion'] = String(data.tokens.completionTokens);
    }
    if (data.tokens.totalTokens) {
      rootSpan.SpanAttributes['llm.tokens.total'] = String(data.tokens.totalTokens);
    }
    if (data.tokens.cached !== undefined) {
      rootSpan.SpanAttributes['llm.cached'] = String(data.tokens.cached);
    }
    if (data.tokens.reasoningTokens !== undefined) {
      rootSpan.SpanAttributes['llm.reasoning_tokens'] = String(data.tokens.reasoningTokens);
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
      rootSpan.SpanAttributes['llm.response_id'] = meta.id;
    }
    if (meta.model) {
      // Update model from response if available (overrides request model)
      rootSpan.SpanAttributes['llm.model'] = meta.model;
    }
    if (meta.object) {
      rootSpan.SpanAttributes['llm.response_object'] = meta.object;
    }
    if (meta.created !== undefined) {
      rootSpan.SpanAttributes['llm.response_created'] = String(meta.created);
    }
    if (meta.finishReason) {
      rootSpan.SpanAttributes['llm.finish_reason'] = meta.finishReason;
    }
    if (meta.nativeFinishReason) {
      rootSpan.SpanAttributes['llm.native_finish_reason'] = meta.nativeFinishReason;
    }
    if (meta.stopReason) {
      rootSpan.SpanAttributes['llm.stop_reason'] = meta.stopReason;
    }
    if (meta.stopSequence) {
      rootSpan.SpanAttributes['llm.stop_sequence'] = meta.stopSequence;
    }
    if (meta.hasLogprobs !== undefined) {
      rootSpan.SpanAttributes['llm.has_logprobs'] = String(meta.hasLogprobs);
    }
    if (meta.reasoningTokens !== undefined) {
      rootSpan.SpanAttributes['llm.reasoning_tokens'] = String(meta.reasoningTokens);
    }
    if (meta.refusal !== undefined) {
      rootSpan.SpanAttributes['llm.has_refusal'] = String(meta.refusal !== null);
    }
    if (meta.reasoning !== undefined) {
      rootSpan.SpanAttributes['llm.has_reasoning'] = String(meta.reasoning !== null);
    }
  }

  traces.push(rootSpan);

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

    // Create TTFT span measuring total time to first token from user perspective
    if (firstContentDelta) {
      const ttftSpan: TinybirdTrace = {
        ReceivedAt: data.receivedAt,
        Timestamp: data.timing.requestStart * 1_000_000,
        TraceId: traceId,
        SpanId: generateSpanId(),
        ParentSpanId: rootSpan.SpanId,
        TraceState: '',
        SpanName: 'llm.request.ttft',
        SpanKind: 'SPAN_KIND_INTERNAL',
        ServiceName: serviceName,
        ResourceAttributes: {
          'service.name': serviceName,
        },
        SpanAttributes: {
          'llm.time_to_first_token_ms': String(
            firstContentDelta.timestamp - data.timing.requestStart,
          ),
        },
        Duration: (firstContentDelta.timestamp - data.timing.requestStart) * 1_000_000,
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

      traces.push(ttftSpan);
    }

    for (const [index, message] of data.sseStreamData.messages.entries()) {
      if (!message.messageStop) {
        console.warn('Incomplete message detected (no messageStop):', {
          messageIndex: index,
          traceId,
        });
        continue;
      }

      const messageSpan: TinybirdTrace = {
        ReceivedAt: data.receivedAt,
        Timestamp: message.messageStart * 1_000_000,
        TraceId: traceId,
        SpanId: generateSpanId(),
        ParentSpanId: rootSpan.SpanId,
        TraceState: '',
        SpanName:
          data.sseStreamData.messages.length > 1
            ? `llm.stream.message.${index + 1}`
            : 'llm.stream.message',
        SpanKind: 'SPAN_KIND_INTERNAL',
        ServiceName: serviceName,
        ResourceAttributes: {
          'service.name': serviceName,
        },
        SpanAttributes: {},
        Duration: (message.messageStop - message.messageStart) * 1_000_000,
        StatusCode: 'STATUS_CODE_OK',
        StatusMessage: '',
        ApiKey: data.apiKey,
        'Events.Timestamp': message.events.map((e) => e.timestamp * 1_000_000),
        'Events.Name': message.events.map((e) => e.type),
        'Events.Attributes': message.events.map(() => '{}'),
        'Links.TraceId': [],
        'Links.SpanId': [],
        'Links.TraceState': [],
        'Links.Attributes': [],
      };

      if (message.usage) {
        if (typeof message.usage.input_tokens === 'number') {
          messageSpan.SpanAttributes['llm.tokens.input'] = String(message.usage.input_tokens);
        }
        if (typeof message.usage.output_tokens === 'number') {
          messageSpan.SpanAttributes['llm.tokens.output'] = String(message.usage.output_tokens);
        }
        if (typeof message.usage.cache_creation_input_tokens === 'number') {
          messageSpan.SpanAttributes['llm.tokens.cache_creation'] = String(
            message.usage.cache_creation_input_tokens,
          );
        }
        if (typeof message.usage.cache_read_input_tokens === 'number') {
          messageSpan.SpanAttributes['llm.tokens.cache_read'] = String(
            message.usage.cache_read_input_tokens,
          );
        }
      }

      traces.push(messageSpan);
    }
  }

  return traces;
}
