import type { QueueMessage, TinybirdTrace } from '@observe/shared/types';
import { generateSpanId, hashString } from '@observe/shared/utils';
import { TraceBatcher } from './batcher';

export { TraceBatcher };

export interface Env {
  STORAGE: R2Bucket;
  TINYBIRD_TOKEN: string;
  TINYBIRD_DATASOURCE?: string;
  TINYBIRD_HOST?: string;
  TRACE_BATCHER: DurableObjectNamespace<TraceBatcher>;
}

const NUM_SHARDS = 10;

export default {
  async queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
    const startTime = Date.now();
    console.log(`Processing queue batch: ${batch.messages.length} messages`);

    const shardedMessages = new Map<
      number,
      {
        traces: TinybirdTrace[];
        messages: Message<QueueMessage>[];
      }
    >();

    const failedMessages: Message<QueueMessage>[] = [];

    for (const message of batch.messages) {
      try {
        const traces = buildTraces(message.body);
        const shardId = hashString(message.body.apiKey) % NUM_SHARDS;

        if (!shardedMessages.has(shardId)) {
          shardedMessages.set(shardId, { traces: [], messages: [] });
        }

        const shard = shardedMessages.get(shardId)!;
        shard.traces.push(...traces);
        shard.messages.push(message);
      } catch (error) {
        console.error('Failed to build traces for message:', {
          requestId: message.body.requestId,
          error: error instanceof Error ? error.message : String(error),
        });
        failedMessages.push(message);
      }
    }

    const shardPromises = Array.from(shardedMessages.entries()).map(async ([shardId, shard]) => {
      try {
        const batcherId = env.TRACE_BATCHER.idFromName(`batcher-${shardId}`);
        const batcher = env.TRACE_BATCHER.get(batcherId);

        await batcher.addTraces(shard.traces);

        for (const message of shard.messages) {
          message.ack();
        }

        console.log(
          `Shard ${shardId}: Successfully processed ${shard.messages.length} messages (${shard.traces.length} traces)`,
        );
      } catch (error) {
        console.error(`Shard ${shardId}: Failed to add traces to batcher:`, {
          error: error instanceof Error ? error.message : String(error),
        });

        for (const message of shard.messages) {
          message.retry();
        }
      }
    });

    await Promise.all(shardPromises);

    for (const message of failedMessages) {
      message.retry();
    }

    console.log(
      `Processed ${batch.messages.length} messages across ${shardedMessages.size} shards in ${Date.now() - startTime}ms`,
    );
  },
};

function buildTraces(data: QueueMessage): TinybirdTrace[] {
  const traces: TinybirdTrace[] = [];
  const traceId = data.requestId;
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

    if (data.sseMessageTiming.firstDelta && data.sseMessageTiming.messageStart) {
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
