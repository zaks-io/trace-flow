import { describe, expect, it } from 'vitest';
import type { Logger } from '@trace-flow/logging';
import { getProvider, type ProviderId } from '@trace-flow/llm-providers';
import { buildTransaction, drainCapture } from '../transaction';
import { attachCapture } from '../pipeline/attachCapture';
import type { ForwardedExchange } from '../pipeline/forwardToUpstream';

const noopLogger: Logger = {
  child: () => noopLogger,
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  flush: () => Promise.resolve(),
};

const ANTHROPIC_START =
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet","usage":{"input_tokens":120,"output_tokens":1}}}\n\n';

function forwardedStream(
  providerId: ProviderId,
  chunks: string[],
  opts: { close?: boolean; operationName?: string } = {},
): ForwardedExchange {
  const encoder = new TextEncoder();
  const response = new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        if (opts.close ?? true) controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
  return {
    validated: {
      requestId: 'req-stream',
      traceId: 'trace-stream',
      traceFlags: 1,
      traceState: '',
      baggage: {},
      apiKey: 'tf-test',
      keyData: { orgId: 'org-1' },
      route: { provider: getProvider(providerId) },
      operationName: opts.operationName ?? 'chat',
    },
    response,
    streamToCapture: null,
    targetUrl: 'https://provider.test/v1/stream',
    requestStart: 0,
    requestSent: 0,
    responseReceived: 0,
  } as unknown as ForwardedExchange;
}

async function runCompleted(forwarded: ForwardedExchange) {
  const attached = attachCapture(forwarded);
  const clientText = new Response(attached.readable).text();
  const drained = await drainCapture(attached);
  attached.capture.release();
  await Promise.all([clientText, attached.pipePromise]);
  return buildTransaction(drained, noopLogger);
}

describe('stream outcome recording', () => {
  it('records an Anthropic error event inside a 200 stream as a failed transaction', async () => {
    const transaction = await runCompleted(
      forwardedStream('anthropic', [
        ANTHROPIC_START,
        'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
      ]),
    );

    expect(transaction.responseStatus).toBe(200);
    expect(transaction.error).toEqual({ type: 'overloaded_error', message: 'Overloaded' });
    expect(transaction.tokens?.promptTokens).toBe(120);
    expect(transaction.responseMetadata?.model).toBe('claude-sonnet');
  });

  it('records a chat stream that ends without [DONE] as incomplete', async () => {
    const transaction = await runCompleted(
      forwardedStream('openai', [
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"gpt-4o","choices":[{"delta":{"content":"hi"}}]}\n\n',
      ]),
    );

    expect(transaction.error).toEqual({
      type: 'stream_incomplete',
      message: 'Upstream stream ended before its terminal event',
    });
    expect(transaction.responseMetadata?.model).toBe('gpt-4o');
  });

  it('records a complete stream without an error', async () => {
    const transaction = await runCompleted(
      forwardedStream('openai', [
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"gpt-4o","choices":[{"delta":{"content":"hi"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":2}}\n\n',
        'data: [DONE]\n\n',
      ]),
    );

    expect(transaction.error).toBeUndefined();
    expect(transaction.tokens?.totalTokens).toBe(11);
  });

  it('keeps usage and model already observed when the stream is interrupted', async () => {
    const attached = attachCapture(
      forwardedStream('anthropic', [ANTHROPIC_START], { close: false }),
    );
    const reader = attached.readable.getReader();
    await reader.read();
    attached.capture.markInterrupted(new Error('upstream reset'));
    const drained = await drainCapture(attached);
    await reader.cancel();
    await attached.pipePromise;

    const transaction = buildTransaction(drained, noopLogger);

    expect(transaction.responseStatus).toBe(502);
    expect(transaction.error?.type).toBe('stream_interrupted');
    expect(transaction.tokens?.promptTokens).toBe(120);
    expect(transaction.responseMetadata?.model).toBe('claude-sonnet');
  });

  it('does not record token-count responses as usage', async () => {
    const forwarded = forwardedStream('anthropic', [], { operationName: 'count_tokens' });
    const response = new Response('{"input_tokens":2048}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const transaction = await runCompleted({ ...forwarded, response });

    expect(transaction.error).toBeUndefined();
    expect(transaction.tokens).toBeUndefined();
  });
});
