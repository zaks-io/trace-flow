import { describe, it, expect, vi } from 'vitest';
import type { Logger } from '@trace-flow/logging';
import type { SSEStreamData } from '@trace-flow/types';
import { getProvider } from '@trace-flow/llm-providers';
import { buildTransaction, drainCapture, recordSkippedExchange } from '../transaction';
import { attachCapture } from '../pipeline/attachCapture';
import type { ProxyEnv } from '../context';
import type { AttachedCapture } from '../pipeline/attachCapture';
import type { ForwardedExchange } from '../pipeline/forwardToUpstream';

const noopLogger: Logger = {
  child: () => noopLogger,
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  flush: () => Promise.resolve(),
};

function makeDrained(opts: {
  providerId: 'openai' | 'google';
  isSSE?: boolean;
  sseMessages?: SSEStreamData['messages'];
  responseBody?: string;
  requestBody?: string;
  responseStatus?: number;
  targetUrl?: string;
  isTruncated?: boolean;
}): Parameters<typeof buildTransaction>[0] {
  const provider = getProvider(opts.providerId);
  const isSSE = opts.isSSE ?? false;
  const sseStreamData: SSEStreamData = { messages: opts.sseMessages ?? [] };
  const response = new Response(opts.responseBody ?? '', { status: opts.responseStatus ?? 200 });
  const forwarded: ForwardedExchange = {
    validated: {
      requestId: 'req_1',
      traceId: 'trace_1',
      parentSpanId: undefined,
      traceFlags: 0,
      traceState: '',
      baggage: {},
      apiKey: 'tf_test',
      keyData: { orgId: 'org_1' },
      route: { provider },
      operationName: 'chat',
    },
    response,
    streamToCapture: null,
    targetUrl: opts.targetUrl ?? 'https://api.openai.com/v1/chat/completions',
    requestStart: 0,
    requestSent: 0,
    responseReceived: 0,
  } as unknown as ForwardedExchange;

  const attached: AttachedCapture = {
    forwarded,
    isSSE,
    sseStreamData,
    parser: null,
    capture: {} as never,
    readable: new ReadableStream(),
    pipePromise: undefined,
  };

  return {
    attached,
    requestBody: opts.requestBody ?? '',
    responseBody: opts.responseBody ?? '',
    firstTokenReceived: undefined,
    isTruncated: opts.isTruncated ?? false,
    totalSize: 0,
    capturedSize: 0,
    responseComplete: 0,
    requestCaptureError: undefined,
    streamError: undefined,
  };
}

describe('buildTransaction', () => {
  it('parses tokens and metadata from a successful non-SSE body', () => {
    const body = JSON.stringify({
      id: 'resp_123',
      model: 'gpt-4o',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    const txn = buildTransaction(
      makeDrained({ providerId: 'openai', responseBody: body }),
      noopLogger,
    );
    expect(txn.tokens?.promptTokens).toBe(10);
    expect(txn.tokens?.completionTokens).toBe(5);
    expect(txn.responseMetadata?.model).toBe('gpt-4o');
    expect(txn.error).toBeUndefined();
    expect(txn.sseStreamData).toBeUndefined();
  });

  it('skips token and metadata parsing on error responses', () => {
    const body = JSON.stringify({ error: { message: 'oops', type: 'invalid_request_error' } });
    const txn = buildTransaction(
      makeDrained({ providerId: 'openai', responseBody: body, responseStatus: 400 }),
      noopLogger,
    );
    expect(txn.tokens).toBeUndefined();
    expect(txn.responseMetadata).toBeUndefined();
    expect(txn.error).toBeDefined();
    expect(txn.error?.message).toBe('oops');
  });

  it('aggregates tokens from SSE messages instead of the response body', () => {
    const txn = buildTransaction(
      makeDrained({
        providerId: 'openai',
        isSSE: true,
        sseMessages: [
          {
            messageStart: 0,
            events: [],
            metadata: { id: 'resp_sse', model: 'gpt-4o-mini' },
            usage: { input_tokens: 8, output_tokens: 4 },
          },
        ],
      }),
      noopLogger,
    );
    expect(txn.isSSE).toBe(true);
    expect(txn.tokens?.promptTokens).toBe(8);
    expect(txn.tokens?.completionTokens).toBe(4);
    expect(txn.responseMetadata?.model).toBe('gpt-4o-mini');
    expect(txn.sseStreamData?.messages).toHaveLength(1);
  });

  it('omits sseStreamData when there are no SSE messages', () => {
    const txn = buildTransaction(
      makeDrained({ providerId: 'openai', isSSE: true, sseMessages: [] }),
      noopLogger,
    );
    expect(txn.sseStreamData).toBeUndefined();
    expect(txn.tokens).toBeUndefined();
    expect(txn.responseMetadata).toBeUndefined();
  });

  it('uses Google URL-path fallback when modelVersion is missing from body', () => {
    const body = JSON.stringify({ embedding: { values: [0.1, 0.2] } });
    const txn = buildTransaction(
      makeDrained({
        providerId: 'google',
        responseBody: body,
        targetUrl:
          'https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent',
      }),
      noopLogger,
    );
    expect(txn.responseMetadata?.model).toBe('text-embedding-004');
  });

  it('parses input messages from the request body', () => {
    const requestBody = JSON.stringify({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const txn = buildTransaction(makeDrained({ providerId: 'openai', requestBody }), noopLogger);
    expect(txn.inputMessages).toBeDefined();
    expect(txn.inputMessages?.[0]?.role).toBe('user');
  });

  it('logs and continues when a provider throws on the request body', () => {
    const error = vi.fn();
    const logger: Logger = { ...noopLogger, error };
    const provider = getProvider('openai');
    const spy = vi.spyOn(provider, 'parseRequestBody').mockImplementation(() => {
      throw new Error('boom');
    });
    try {
      const txn = buildTransaction(
        makeDrained({ providerId: 'openai', requestBody: '{}' }),
        logger,
      );
      expect(error).toHaveBeenCalledWith('proxy.request_body_parse_failed', expect.any(Error));
      expect(txn.inputMessages).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('skips input message parsing when the request body is empty', () => {
    const error = vi.fn();
    const logger: Logger = { ...noopLogger, error };
    const txn = buildTransaction(makeDrained({ providerId: 'openai', requestBody: '' }), logger);
    expect(error).not.toHaveBeenCalled();
    expect(txn.inputMessages).toBeUndefined();
  });

  it('warns on truncated responses', () => {
    const warn = vi.fn();
    const logger: Logger = { ...noopLogger, warn };
    buildTransaction(
      makeDrained({
        providerId: 'openai',
        responseBody: '{}',
        isTruncated: true,
      }),
      logger,
    );
    expect(warn).toHaveBeenCalledWith('proxy.response_truncated', expect.any(Object));
  });

  it('records interrupted response streams as explicit failed transactions', () => {
    const drained = makeDrained({
      providerId: 'openai',
      responseBody: '{"partial":',
    });
    drained.streamError = new Error('upstream stream reset');
    drained.totalSize = 11;
    drained.capturedSize = 11;

    const transaction = buildTransaction(drained, noopLogger);

    expect(transaction.responseStatus).toBe(502);
    expect(transaction.error).toEqual({
      type: 'stream_interrupted',
      message: 'Upstream response stream did not complete',
    });
    expect(transaction.responseBody).toBe('{"partial":');
    expect(transaction.responseMetadata).toBeUndefined();
  });

  it('preserves a completed upstream response when request capture fails', async () => {
    const responseBody = JSON.stringify({
      id: 'resp_123',
      model: 'gpt-4o',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    const provider = getProvider('openai');
    const forwarded = {
      validated: {
        requestId: 'req-capture-failure',
        traceId: 'trace-capture-failure',
        traceFlags: 1,
        traceState: '',
        baggage: {},
        apiKey: 'tf-test',
        keyData: { orgId: 'org-1' },
        route: { provider },
      },
      response: new Response(responseBody, { status: 200 }),
      streamToCapture: new ReadableStream({
        start(controller) {
          controller.error(new Error('request capture failed'));
        },
      }),
      targetUrl: 'https://api.openai.com/v1/chat/completions',
      requestStart: 0,
      requestSent: 0,
      responseReceived: 0,
    } as unknown as ForwardedExchange;
    const attached = attachCapture(forwarded);
    const clientResponse = new Response(attached.readable).text();
    const drained = await drainCapture(attached);
    attached.capture.release();
    await clientResponse;
    await attached.pipePromise;
    const error = vi.fn();

    const transaction = buildTransaction(drained, { ...noopLogger, error });

    expect(drained.requestCaptureError).toBeDefined();
    expect(drained.streamError).toBeUndefined();
    expect(transaction.responseStatus).toBe(200);
    expect(transaction.error).toBeUndefined();
    expect(transaction.tokens?.totalTokens).toBe(15);
    expect(transaction.responseMetadata?.model).toBe('gpt-4o');
    expect(transaction.isTruncated).toBe(true);
    expect(error).toHaveBeenCalledWith('proxy.request_capture_failed', expect.any(Error));
  });

  it('does not synthesize completion for an interrupted partial SSE event', async () => {
    const provider = getProvider('anthropic');
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'event: message_start\ndata: {"type":"message_start","message":{"id":"msg","model":"claude","usage":{"input_tokens":1}}}',
            ),
          );
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
    const forwarded = {
      validated: {
        requestId: 'req-sse',
        traceId: 'trace-sse',
        traceFlags: 1,
        traceState: '',
        baggage: {},
        apiKey: 'tf-test',
        keyData: { orgId: 'org-1' },
        route: { provider },
      },
      response,
      streamToCapture: null,
      targetUrl: 'https://api.anthropic.com/v1/messages',
      requestStart: 0,
      requestSent: 0,
      responseReceived: 0,
    } as unknown as ForwardedExchange;
    const attached = attachCapture(forwarded);
    const clientReader = attached.readable.getReader();
    await clientReader.read();
    attached.capture.markInterrupted(new Error('upstream reset'));

    const drained = await drainCapture(attached);
    await clientReader.cancel();
    await attached.pipePromise;

    expect(drained.streamError).toBeDefined();
    expect(attached.sseStreamData.messages).toEqual([]);
    expect(drained.responseBody).toContain('message_start');
  });

  it('releases skipped responses even when analytics throws', async () => {
    const provider = getProvider('openai');
    const route = { provider } as Parameters<typeof recordSkippedExchange>[2]['route'];
    const forwarded = {
      validated: {
        decision: { record: false, reason: 'exceeded' },
        keyData: { orgId: 'org-1' },
        operationName: 'chat',
        route,
      },
      response: new Response('{"ok":true}', { status: 200 }),
      streamToCapture: null,
      targetUrl: 'https://api.openai.com/v1/chat/completions',
      requestStart: 0,
      requestSent: 0,
      responseReceived: 0,
    } as unknown as ForwardedExchange;
    const attached = attachCapture(forwarded);
    const responseText = new Response(attached.readable).text();
    const env = {
      ANALYTICS: {
        writeDataPoint: () => {
          throw new Error('analytics unavailable');
        },
      },
    } as unknown as ProxyEnv;

    await recordSkippedExchange(env, attached, {
      decision: { record: false, reason: 'exceeded' },
      route,
      logger: noopLogger,
    });

    await expect(responseText).resolves.toBe('{"ok":true}');
  });
});
