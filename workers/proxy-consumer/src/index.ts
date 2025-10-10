import type { QueueMessage } from '@observe/shared/types';

interface Env {
  STORAGE: R2Bucket;
  CLICKHOUSE_HOST: string;
  CLICKHOUSE_USERNAME: string;
  CLICKHOUSE_PASSWORD: string;
  CLICKHOUSE_DATABASE?: string;
}

interface ClickHouseTrace {
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
  'Events.Timestamp': number[];
  'Events.Name': string[];
  'Events.Attributes': Record<string, string>[];
  'Links.TraceId': string[];
  'Links.SpanId': string[];
  'Links.TraceState': string[];
  'Links.Attributes': Record<string, string>[];
}

export default {
  async queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await processMessage(message.body, env);
        message.ack();
      } catch (error) {
        console.error('Failed to process message:', {
          requestId: message.body.requestId,
          error: error instanceof Error ? error.message : String(error),
        });
        message.retry();
      }
    }
  },
};

async function processMessage(data: QueueMessage, env: Env): Promise<void> {
  const traces = buildTraces(data);

  await insertIntoClickHouse(traces, env);

  console.log('Successfully inserted traces into ClickHouse:', {
    requestId: data.requestId,
    traceCount: traces.length,
  });
}

function buildTraces(data: QueueMessage): ClickHouseTrace[] {
  const traces: ClickHouseTrace[] = [];
  const traceId = data.requestId;
  const serviceName = 'llm-observability';

  const rootSpan: ClickHouseTrace = {
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

  const requestSpan: ClickHouseTrace = {
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
    'Events.Timestamp': [],
    'Events.Name': [],
    'Events.Attributes': [],
    'Links.TraceId': [],
    'Links.SpanId': [],
    'Links.TraceState': [],
    'Links.Attributes': [],
  };

  traces.push(requestSpan);

  if (data.timing.firstTokenReceived) {
    const ttftSpan: ClickHouseTrace = {
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
      'Events.Timestamp': [],
      'Events.Name': [],
      'Events.Attributes': [],
      'Links.TraceId': [],
      'Links.SpanId': [],
      'Links.TraceState': [],
      'Links.Attributes': [],
    };

    traces.push(ttftSpan);

    const streamingSpan: ClickHouseTrace = {
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

async function insertIntoClickHouse(traces: ClickHouseTrace[], env: Env): Promise<void> {
  const database = env.CLICKHOUSE_DATABASE ?? 'default';
  const query = `INSERT INTO ${database}.otel_traces FORMAT JSONEachRow`;

  const url = `${env.CLICKHOUSE_HOST}/?query=${encodeURIComponent(query)}`;

  const auth = btoa(`${env.CLICKHOUSE_USERNAME}:${env.CLICKHOUSE_PASSWORD}`);

  const body = traces.map((trace) => JSON.stringify(trace)).join('\n');

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${auth}`,
    },
    body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ClickHouse insert failed: ${response.status} ${errorText}`);
  }
}

function generateSpanId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
