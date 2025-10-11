import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createParser } from 'eventsource-parser';
import { generateId, getCurrentTimestamp, extractProviderFromUrl } from '@observe/shared/utils';
import type {
  QueueMessage,
  LLMTiming,
  LLMTokenUsage,
  LLMError,
  SSEMessageTiming,
  SSEMetadata,
} from '@observe/shared/types';

interface Env {
  REQUEST_QUEUE: Queue<QueueMessage>;
  STORAGE: R2Bucket;
}

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors());

app.all('*', async (c) => {
  const requestId = generateId();
  const requestStart = getCurrentTimestamp();
  const targetUrl = c.req.header('X-Proxy-Target');

  console.log('Incoming Request:', {
    requestId,
    timestamp: requestStart,
    method: c.req.method,
    url: c.req.url,
    targetUrl,
    contentType: c.req.header('Content-Type'),
    authorization: c.req.header('Authorization') ? '[PRESENT]' : '[MISSING]',
  });

  if (!targetUrl) {
    return c.json(
      {
        error: 'Missing X-Proxy-Target header',
        message: 'Please provide the target URL in the X-Proxy-Target header',
      },
      400,
    );
  }

  const [streamToProxy, streamToCapture] = c.req.raw.body?.tee() ?? [null, null];

  const headers = new Headers(c.req.raw.headers);
  headers.delete('X-Proxy-Target');
  headers.delete('host');

  const requestSent = getCurrentTimestamp();
  const response = await fetch(targetUrl, {
    method: c.req.method,
    headers,
    body: streamToProxy,
  });

  let firstTokenReceived: number | undefined;
  const responseComplete = getCurrentTimestamp();
  const latency = responseComplete - requestStart;

  console.log('Response:', {
    requestId,
    status: response.status,
    latency,
    contentType: response.headers.get('Content-Type'),
  });

  const responseCapturedChunks: Uint8Array[] = [];
  let isFirstChunk = true;
  const isSSE = response.headers.get('Content-Type')?.includes('text/event-stream') ?? false;

  if (isSSE) {
    console.log('SSE stream detected for request:', requestId);
  }

  const sseMessageTiming: SSEMessageTiming = {};
  const sseMetadata: SSEMetadata = {};

  const parser = isSSE
    ? createParser({
        onEvent(event) {
          const timestamp = getCurrentTimestamp();

          console.log('SSE Event:', {
            event: event.event,
            timestamp,
            data: event.data?.substring(0, 100),
          });

          processSSEEvent(event, timestamp, sseMessageTiming, sseMetadata);
        },
      })
    : null;

  const decoder = new TextDecoder();

  const { readable, writable } = new TransformStream<Uint8Array>({
    transform(chunk, controller) {
      if (isFirstChunk) {
        firstTokenReceived = getCurrentTimestamp();
        isFirstChunk = false;
      }
      responseCapturedChunks.push(chunk);

      if (isSSE && parser) {
        const text = decoder.decode(chunk);
        parser.feed(text);
      }

      controller.enqueue(chunk);
    },
  });

  const pipePromise = response.body?.pipeTo(writable);

  c.executionCtx.waitUntil(
    (async () => {
      const requestBody = await captureStream(streamToCapture);
      await pipePromise;

      const responseBody = new TextDecoder().decode(
        new Uint8Array(responseCapturedChunks.flatMap((chunk) => Array.from(chunk))),
      );

      const timing: LLMTiming = {
        requestStart,
        requestSent,
        firstTokenReceived,
        responseComplete: getCurrentTimestamp(),
      };

      let tokens: LLMTokenUsage | undefined;
      let error: LLMError | undefined;

      if (response.status >= 400) {
        error = parseError(responseBody, response.status);
      } else {
        tokens = parseTokenUsage(responseBody);
      }

      const requestBodyKey = `requests/${requestId}`;
      const responseBodyKey = `responses/${requestId}`;

      console.log('Storing request/response bodies in R2:', {
        requestId,
        requestBodyKey,
        responseBodyKey,
        requestBodySize: requestBody.length,
        responseBodySize: responseBody.length,
      });

      await Promise.all([
        c.env.STORAGE.put(requestBodyKey, requestBody),
        c.env.STORAGE.put(responseBodyKey, responseBody),
      ]);

      console.log('Successfully stored in R2:', {
        requestId,
      });

      const provider = extractProviderFromUrl(targetUrl);

      const queueMessage: QueueMessage = {
        requestId,
        targetUrl,
        request: {
          id: requestId,
          provider,
          model: 'unknown',
          messages: [],
          timestamp: requestStart,
        },
        response: {
          id: requestId,
          provider,
          status: response.status,
          timestamp: timing.responseComplete,
          latency,
        },
        requestBodyKey,
        responseBodyKey,
        timing,
        tokens,
        error,
      };

      if (isSSE && Object.keys(sseMessageTiming).length > 0) {
        queueMessage.sseMessageTiming = sseMessageTiming;
      }

      if (isSSE && Object.keys(sseMetadata).length > 0) {
        queueMessage.sseMetadata = sseMetadata;
      }

      if (isSSE) {
        console.log('SSE Message Timing:', {
          requestId,
          sseMessageTiming: queueMessage.sseMessageTiming,
          sseMetadata: queueMessage.sseMetadata,
        });
      }

      await c.env.REQUEST_QUEUE.send(queueMessage);
      console.log('Successfully queued message:', {
        requestId,
        provider,
        targetUrl,
        requestBodyKey,
        responseBodyKey,
        tokens,
        error,
      });
    })(),
  );

  return new Response(readable, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
});

async function captureStream(stream: ReadableStream | null): Promise<string> {
  if (!stream) return '';

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];

  while (true) {
    const result = await reader.read();
    if (result.done) break;
    if (result.value instanceof Uint8Array) {
      chunks.push(result.value);
    }
  }

  return new TextDecoder().decode(new Uint8Array(chunks.flatMap((chunk) => Array.from(chunk))));
}

function parseTokenUsage(responseBody: string): LLMTokenUsage | undefined {
  try {
    const parsed = JSON.parse(responseBody) as unknown;

    if (
      parsed &&
      typeof parsed === 'object' &&
      'usage' in parsed &&
      parsed.usage &&
      typeof parsed.usage === 'object'
    ) {
      const usage = parsed.usage as Record<string, unknown>;

      let cached: boolean | undefined;
      if (usage.prompt_tokens_details && typeof usage.prompt_tokens_details === 'object') {
        const details = usage.prompt_tokens_details as Record<string, unknown>;
        if ('cached_tokens' in details && typeof details.cached_tokens === 'number') {
          cached = details.cached_tokens > 0;
        }
      }

      return {
        promptTokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined,
        completionTokens:
          typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined,
        totalTokens: typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined,
        cached,
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function parseError(responseBody: string, statusCode: number): LLMError {
  try {
    const parsed = JSON.parse(responseBody) as unknown;

    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      const errorObj =
        obj.error && typeof obj.error === 'object' ? (obj.error as Record<string, unknown>) : null;

      return {
        type:
          (errorObj && typeof errorObj.type === 'string' ? errorObj.type : null) ??
          (typeof obj.type === 'string' ? obj.type : null) ??
          'http_error',
        message:
          (errorObj && typeof errorObj.message === 'string' ? errorObj.message : null) ??
          (typeof obj.message === 'string' ? obj.message : null) ??
          `HTTP ${statusCode}`,
        code:
          (errorObj && typeof errorObj.code === 'string' ? errorObj.code : null) ??
          (typeof obj.code === 'string' ? obj.code : null) ??
          undefined,
      };
    }
  } catch {
    return {
      type: 'http_error',
      message: `HTTP ${statusCode}`,
    };
  }

  return {
    type: 'http_error',
    message: `HTTP ${statusCode}`,
  };
}

function processSSEEvent(
  event: { event?: string; data: string },
  timestamp: number,
  timing: SSEMessageTiming,
  metadata: SSEMetadata,
): void {
  try {
    const eventType = event.event;
    if (eventType === 'message_start' && timing.messageStart === undefined) {
      timing.messageStart = timestamp;
      return;
    }

    if (eventType === 'content_block_start' && timing.contentBlockStart === undefined) {
      timing.contentBlockStart = timestamp;
      return;
    }

    if (eventType === 'content_block_delta' && timing.firstDelta === undefined) {
      timing.firstDelta = timestamp;
      return;
    }

    if (eventType === 'message_delta') {
      const parsed = JSON.parse(event.data) as unknown;
      if (parsed && typeof parsed === 'object') {
        const delta = parsed as Record<string, unknown>;
        const usage = delta.usage;
        if (usage && typeof usage === 'object') {
          const typedUsage = usage as Record<string, unknown>;
          metadata.usage = {
            input_tokens:
              typeof typedUsage.input_tokens === 'number' ? typedUsage.input_tokens : undefined,
            cache_creation_input_tokens:
              typeof typedUsage.cache_creation_input_tokens === 'number'
                ? typedUsage.cache_creation_input_tokens
                : undefined,
            cache_read_input_tokens:
              typeof typedUsage.cache_read_input_tokens === 'number'
                ? typedUsage.cache_read_input_tokens
                : undefined,
            output_tokens:
              typeof typedUsage.output_tokens === 'number' ? typedUsage.output_tokens : undefined,
          };
        }
      }
      return;
    }

    if (eventType === 'message_stop') {
      timing.messageStop = timestamp;
      const parsed = JSON.parse(event.data) as unknown;
      if (parsed && typeof parsed === 'object') {
        const stop = parsed as Record<string, unknown>;
        const usage = stop.usage;
        if (usage && typeof usage === 'object') {
          const typedUsage = usage as Record<string, unknown>;
          metadata.finalUsage = {
            input_tokens:
              typeof typedUsage.input_tokens === 'number' ? typedUsage.input_tokens : undefined,
            cache_creation_input_tokens:
              typeof typedUsage.cache_creation_input_tokens === 'number'
                ? typedUsage.cache_creation_input_tokens
                : undefined,
            cache_read_input_tokens:
              typeof typedUsage.cache_read_input_tokens === 'number'
                ? typedUsage.cache_read_input_tokens
                : undefined,
            output_tokens:
              typeof typedUsage.output_tokens === 'number' ? typedUsage.output_tokens : undefined,
          };
        }
      }
    }
  } catch (e) {
    console.error('Error parsing SSE event:', e);
  }
}

export default app;
