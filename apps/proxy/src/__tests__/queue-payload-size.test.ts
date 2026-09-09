import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../index';
import type { ProxyEnv } from '../context';

// Cloudflare Queues rejects messages over 128 KB with "Payload Too Large":
// https://developers.cloudflare.com/queues/configuration/javascript-apis/
const QUEUE_MESSAGE_LIMIT_BYTES = 128 * 1024;
const credential = 'queue-payload-size-test';

async function setupCredential(orgId: string): Promise<void> {
  await env.API_KEYS.put(
    credential,
    JSON.stringify({ orgId, createdAt: Date.now(), expiresAt: Date.now() + 86400000 }),
  );
  await env.API_KEYS.put(
    `sub:${orgId}`,
    JSON.stringify({ tier: 'pro', status: 'active', monthlyUnits: 100000, addonUnits: 0 }),
  );
}

function largeAnthropicStream(): string {
  const chunk = 'x'.repeat(1_000);
  const deltas = Array.from(
    { length: 200 },
    (_, index) =>
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: `${index}:${chunk}` },
      })}\n\n`,
  ).join('');
  const start = JSON.stringify({
    type: 'message_start',
    message: { id: 'msg_large', model: 'claude-3', usage: { input_tokens: 10 } },
  });
  const finish = JSON.stringify({ type: 'message_delta', usage: { output_tokens: 50_000 } });
  return [
    `event: message_start\ndata: ${start}\n\n`,
    deltas,
    `event: message_delta\ndata: ${finish}\n\n`,
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join('');
}

function largeOpenAIResponse(): string {
  return JSON.stringify({
    id: 'chatcmpl-large',
    model: 'gpt-4',
    choices: [{ message: { role: 'assistant', content: 'y'.repeat(200_000) } }],
    usage: { prompt_tokens: 10, completion_tokens: 50_000, total_tokens: 50_010 },
  });
}

interface PayloadCase {
  name: string;
  path: string;
  headers: Record<string, string>;
  request: Record<string, unknown>;
  upstream: () => Response;
  expectStreamData: boolean;
}

const cases: PayloadCase[] = [
  {
    name: 'streamed Anthropic response',
    path: '/anthropic/v1/messages',
    headers: { 'x-api-key': 'anthropic-key', 'anthropic-version': '2023-06-01' },
    request: { model: 'claude-3', messages: [{ role: 'user', content: 'hi' }], stream: true },
    upstream: () =>
      new Response(largeAnthropicStream(), { headers: { 'Content-Type': 'text/event-stream' } }),
    expectStreamData: true,
  },
  {
    name: 'buffered OpenAI response',
    path: '/openai/v1/chat/completions',
    headers: { Authorization: 'Bearer openai-key' },
    request: { model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] },
    upstream: () =>
      new Response(largeOpenAIResponse(), { headers: { 'Content-Type': 'application/json' } }),
    expectStreamData: false,
  },
];

describe('queue payload size', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(cases)(
    'keeps a $name over the queue limit in R2 and queues only a reference',
    async ({ path, headers, request, upstream, expectStreamData }) => {
      await setupCredential('org-queue-payload');
      let upstreamBytes = 0;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        await new Request(input, init).arrayBuffer();
        const response = upstream();
        upstreamBytes = (await response.clone().text()).length;
        return response;
      });
      const send = vi.fn().mockResolvedValue(undefined);
      const put = vi.fn(async (key: string, _value: string) => ({ key }));
      const bindings = {
        ...env,
        REQUEST_QUEUE: { send },
        STORAGE: { put },
        TRACE_DELIVERY_NAMESPACE: 'dev',
      } as unknown as ProxyEnv;
      const context = createExecutionContext();

      const response = await worker.fetch(
        new Request(`https://proxy.test${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Trace-Flow-Api-Key': credential,
            ...headers,
          },
          body: JSON.stringify(request),
        }),
        bindings,
        context,
      );
      const delivered = await response.text();
      await waitOnExecutionContext(context);

      expect(response.status).toBe(200);
      expect(upstreamBytes).toBeGreaterThan(QUEUE_MESSAGE_LIMIT_BYTES);
      expect(delivered.length).toBe(upstreamBytes);

      expect(put).toHaveBeenCalledTimes(1);
      const [deliveryKey, storedValue] = put.mock.calls[0]!;
      expect(deliveryKey).toMatch(/^trace-deliveries\/dev-/);
      expect(storedValue.length).toBeGreaterThan(QUEUE_MESSAGE_LIMIT_BYTES);
      const envelope = JSON.parse(storedValue);
      expect(envelope.message.truncated).toBe(false);
      expect(envelope.body).toBeDefined();
      if (expectStreamData) {
        expect(envelope.message.sseStreamData.messages[0].events.length).toBeGreaterThan(200);
      }

      expect(send).toHaveBeenCalledTimes(1);
      const reference = send.mock.calls[0]![0];
      expect(reference).toMatchObject({ type: 'delivery', key: deliveryKey });
      const extraKeys = Object.keys(reference).filter(
        (field) => !['type', 'key', 'sentry_trace_context'].includes(field),
      );
      expect(extraKeys).toEqual([]);
      expect(JSON.stringify(reference).length).toBeLessThan(QUEUE_MESSAGE_LIMIT_BYTES);
    },
  );
});
