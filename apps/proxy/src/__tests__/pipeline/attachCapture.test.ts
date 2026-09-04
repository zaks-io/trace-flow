import { describe, it, expect } from 'vitest';
import { getProvider } from '@trace-flow/llm-providers';
import { attachCapture } from '../../pipeline/attachCapture';
import type { ForwardedExchange } from '../../pipeline/forwardToUpstream';

const provider = getProvider('openai');

function makeForwarded(contentType: string, bodyText: string): ForwardedExchange {
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(bodyText));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': contentType } },
  );
  return {
    validated: { route: { provider } },
    response,
    streamToCapture: null,
    targetUrl: 'https://api.openai.com/v1/chat/completions',
    requestStart: 0,
    requestSent: 0,
    responseReceived: 0,
  } as unknown as ForwardedExchange;
}

async function drain(stream: ReadableStream): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

describe('attachCapture', () => {
  it('detects SSE and installs a parser', () => {
    const attached = attachCapture(makeForwarded('text/event-stream', ''));
    expect(attached.isSSE).toBe(true);
    expect(attached.parser).not.toBeNull();
  });

  it('does not install a parser for JSON responses', () => {
    const attached = attachCapture(makeForwarded('application/json', '{}'));
    expect(attached.isSSE).toBe(false);
    expect(attached.parser).toBeNull();
  });

  it('forwards response body bytes to the readable returned to the client', async () => {
    const attached = attachCapture(makeForwarded('application/json', '{"hello":"world"}'));
    const draining = drain(attached.readable);
    await attached.capture.waitForDrain();
    attached.capture.release();
    const drained = await draining;
    await attached.pipePromise;
    expect(drained).toBe('{"hello":"world"}');
  });

  it('exposes empty sseStreamData by default', () => {
    const attached = attachCapture(makeForwarded('application/json', '{}'));
    expect(attached.sseStreamData.messages).toEqual([]);
  });

  it('reports client cancellation as an interrupted capture', async () => {
    const attached = attachCapture(makeForwarded('application/json', '{"partial":true}'));
    const reader = attached.readable.getReader();
    await reader.read();
    await reader.cancel(new Error('client disconnected'));

    await expect(attached.capture.waitForDrain()).resolves.toMatchObject({ complete: false });
    attached.capture.release();
    await attached.pipePromise;
  });
});
