import { trace, context, SpanStatusCode } from '@opentelemetry/api';
import { instrument } from '@microlabs/otel-cf-workers';
import type { ResolveConfigFn } from '@microlabs/otel-cf-workers';
import type { QueueMessage } from '@observe/shared/types';

interface Env {
  STORAGE: R2Bucket;
  CLICKSTACK_OTLP_ENDPOINT?: string;
  CLICKSTACK_API_KEY?: string;
  OTEL_SERVICE_NAME?: string;
}

const handler = {
  queue(batch: MessageBatch<QueueMessage>, env: Env): void {
    for (const message of batch.messages) {
      processMessage(message.body, env);
      message.ack();
    }
  },
};

const config: ResolveConfigFn = (env: Env) => {
  const headers: Record<string, string> = {};
  if (env.CLICKSTACK_API_KEY) {
    headers.authorization = env.CLICKSTACK_API_KEY;
  }

  return {
    exporter: {
      url: env.CLICKSTACK_OTLP_ENDPOINT ?? 'http://localhost:4318/v1/traces',
      headers,
    },
    service: {
      name: env.OTEL_SERVICE_NAME ?? 'llm-observability',
    },
  };
};

export default instrument(handler, config);

function processMessage(data: QueueMessage, _env: Env): void {
  const tracer = trace.getTracer('llm-observability');

  const rootSpan = tracer.startSpan('llm.request', {
    startTime: data.timing.requestStart,
  });

  const rootContext = trace.setSpan(context.active(), rootSpan);

  rootSpan.setAttribute('llm.request_id', data.requestId);
  rootSpan.setAttribute('llm.provider', data.request.provider);
  rootSpan.setAttribute('llm.model', data.request.model);
  rootSpan.setAttribute('http.status_code', data.response.status);

  if (data.tokens) {
    if (data.tokens.promptTokens) {
      rootSpan.setAttribute('llm.tokens.prompt', data.tokens.promptTokens);
    }
    if (data.tokens.completionTokens) {
      rootSpan.setAttribute('llm.tokens.completion', data.tokens.completionTokens);
    }
    if (data.tokens.totalTokens) {
      rootSpan.setAttribute('llm.tokens.total', data.tokens.totalTokens);
    }
    if (data.tokens.cached !== undefined) {
      rootSpan.setAttribute('llm.cached', data.tokens.cached);
    }
  }

  if (data.error) {
    rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: data.error.message });
    if (data.error.type) {
      rootSpan.setAttribute('error.type', data.error.type);
    }
    if (data.error.message) {
      rootSpan.setAttribute('error.message', data.error.message);
    }
    if (data.error.code) {
      rootSpan.setAttribute('error.code', data.error.code);
    }
  }

  const requestSpan = tracer.startSpan(
    'llm.request.send',
    {
      startTime: data.timing.requestStart,
    },
    rootContext,
  );
  requestSpan.end(data.timing.requestSent);

  if (data.timing.firstTokenReceived) {
    const ttftSpan = tracer.startSpan(
      'llm.request.ttft',
      {
        startTime: data.timing.requestSent,
      },
      rootContext,
    );
    ttftSpan.setAttribute(
      'llm.time_to_first_token_ms',
      data.timing.firstTokenReceived - data.timing.requestSent,
    );
    ttftSpan.end(data.timing.firstTokenReceived);

    const streamingSpan = tracer.startSpan(
      'llm.response.streaming',
      {
        startTime: data.timing.firstTokenReceived,
      },
      rootContext,
    );
    streamingSpan.end(data.timing.responseComplete);
  }

  rootSpan.end(data.timing.responseComplete);
}

// async function storeInR2(data: QueueMessage, env: Env): Promise<void> {
//   if (!env.STORAGE) return;
//
//   const requestKey = `requests/${data.requestId}/request.json`;
//   const responseKey = `requests/${data.requestId}/response.json`;
//
//   await env.STORAGE.put(requestKey, data.requestBody);
//   await env.STORAGE.put(responseKey, data.responseBody);
// }

// async function writeToClickHouse(data: QueueMessage, env: Env): Promise<void> {
//   if (!env.CLICKHOUSE_HOST) return;
//
//   const row = {
//     id: data.requestId,
//     provider: data.request.provider,
//     model: data.request.model,
//     status: data.response.status,
//     latency: data.response.latency,
//     timestamp: data.request.timestamp,
//   };
//
//   const url = `${env.CLICKHOUSE_HOST}/?query=INSERT INTO llm_requests FORMAT JSONEachRow`;
//   await fetch(url, {
//     method: 'POST',
//     headers: {
//       'Content-Type': 'application/json',
//       'X-ClickHouse-User': env.CLICKHOUSE_USER || '',
//       'X-ClickHouse-Key': env.CLICKHOUSE_PASSWORD || '',
//     },
//     body: JSON.stringify(row),
//   });
// }
