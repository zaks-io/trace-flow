import { describe, it, expect } from 'vitest';
import { getProvider } from '@trace-flow/llm-providers';
import { attachCapture } from '../../pipeline/attachCapture';

const provider = getProvider('openai');

function makeResponse(contentType: string, bodyText: string): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(bodyText));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': contentType } },
  );
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
    const attached = attachCapture(makeResponse('text/event-stream', ''), provider);
    expect(attached.isSSE).toBe(true);
    expect(attached.parser).not.toBeNull();
  });

  it('does not install a parser for JSON responses', () => {
    const attached = attachCapture(makeResponse('application/json', '{}'), provider);
    expect(attached.isSSE).toBe(false);
    expect(attached.parser).toBeNull();
  });

  it('forwards response body bytes to the readable returned to the client', async () => {
    const response = makeResponse('application/json', '{"hello":"world"}');
    const attached = attachCapture(response, provider);
    const drained = await drain(attached.readable);
    await attached.pipePromise;
    expect(drained).toBe('{"hello":"world"}');
  });

  it('exposes empty sseStreamData by default', () => {
    const attached = attachCapture(makeResponse('application/json', '{}'), provider);
    expect(attached.sseStreamData.messages).toEqual([]);
  });
});
