import type { QueueMessage, TinybirdTrace } from '@observe/types';
import { generateSpanId } from '@observe/utils';

/**
 * Transforms queue messages into OpenTelemetry traces for Tinybird storage.
 *
 * Creates a trace hierarchy:
 * - Root span: Overall LLM request with status, model, provider metadata
 * - Request span: Time to send request to provider
 * - SSE/TTFT spans: Streaming-specific timing (when available)
 *
 * SSE responses generate a message span with TTFT and token usage.
 * Non-SSE responses generate separate TTFT and streaming spans when firstTokenReceived is present.
 */
export function buildTraces(data: QueueMessage): TinybirdTrace[] {
  const traces: TinybirdTrace[] = [];
  const traceId = data.traceId ?? data.requestId;
  const serviceName = 'llm-observability';

  const rootSpan: TinybirdTrace = {
    Timestamp: data.timing.requestStart * 1000000,
    TraceId: traceId,
    SpanId: generateSpanId(),
    ParentSpanId: '',
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
    Duration: (data.timing.responseComplete - data.timing.requestStart) * 1000000,
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
  }

  if (data.error) {
    if (data.error.type) {
      rootSpan.SpanAttributes['error.type'] = data.error.type;
    }
    if (data.error.code) {
      rootSpan.SpanAttributes['error.code'] = data.error.code;
    }
  }

  traces.push(rootSpan);

  const requestSpan: TinybirdTrace = {
    Timestamp: data.timing.requestStart * 1000000,
    TraceId: traceId,
    SpanId: generateSpanId(),
    ParentSpanId: rootSpan.SpanId,
    TraceState: '',
    SpanName: 'llm.request.send',
    SpanKind: 'SPAN_KIND_INTERNAL',
    ServiceName: serviceName,
    ResourceAttributes: {
      'service.name': serviceName,
    },
    SpanAttributes: {},
    Duration: (data.timing.requestSent - data.timing.requestStart) * 1000000,
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

  traces.push(requestSpan);

  if (data.sseMessageTiming?.messageStart && data.sseMessageTiming?.messageStop) {
    const messageSpan: TinybirdTrace = {
      Timestamp: data.sseMessageTiming.messageStart * 1000000,
      TraceId: traceId,
      SpanId: generateSpanId(),
      ParentSpanId: rootSpan.SpanId,
      TraceState: '',
      SpanName: 'llm.stream.message',
      SpanKind: 'SPAN_KIND_INTERNAL',
      ServiceName: serviceName,
      ResourceAttributes: {
        'service.name': serviceName,
      },
      SpanAttributes: {},
      Duration: (data.sseMessageTiming.messageStop - data.sseMessageTiming.messageStart) * 1000000,
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

    if (data.sseMessageTiming.firstDelta) {
      messageSpan.SpanAttributes['llm.time_to_first_token_ms'] = String(
        data.sseMessageTiming.firstDelta - data.sseMessageTiming.messageStart,
      );
    }

    if (data.sseMetadata) {
      if (
        data.sseMetadata.finalUsage &&
        typeof data.sseMetadata.finalUsage === 'object' &&
        data.sseMetadata.finalUsage
      ) {
        const usage = data.sseMetadata.finalUsage as Record<string, unknown>;
        if (typeof usage.input_tokens === 'number') {
          messageSpan.SpanAttributes['llm.tokens.input'] = String(usage.input_tokens);
        }
        if (typeof usage.output_tokens === 'number') {
          messageSpan.SpanAttributes['llm.tokens.output'] = String(usage.output_tokens);
        }
      }
    }

    traces.push(messageSpan);
  } else if (data.timing.firstTokenReceived) {
    const ttftSpan: TinybirdTrace = {
      Timestamp: data.timing.requestSent * 1000000,
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
          data.timing.firstTokenReceived - data.timing.requestSent,
        ),
      },
      Duration: (data.timing.firstTokenReceived - data.timing.requestSent) * 1000000,
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

    const streamingSpan: TinybirdTrace = {
      Timestamp: data.timing.firstTokenReceived * 1000000,
      TraceId: traceId,
      SpanId: generateSpanId(),
      ParentSpanId: rootSpan.SpanId,
      TraceState: '',
      SpanName: 'llm.response.streaming',
      SpanKind: 'SPAN_KIND_INTERNAL',
      ServiceName: serviceName,
      ResourceAttributes: {
        'service.name': serviceName,
      },
      SpanAttributes: {},
      Duration: (data.timing.responseComplete - data.timing.firstTokenReceived) * 1000000,
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

    traces.push(streamingSpan);
  }

  return traces;
}
