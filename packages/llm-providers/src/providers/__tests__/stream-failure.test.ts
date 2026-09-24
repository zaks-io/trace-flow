import { describe, expect, it } from 'vitest';
import type { SSEStreamData } from '@trace-flow/types';
import type { ParsedSSEEvent, Provider } from '../types';
import { PROVIDERS } from '../index';

function replay(provider: Provider, events: ParsedSSEEvent[]): SSEStreamData {
  const state: SSEStreamData = { messages: [] };
  events.forEach((event, i) => provider.handleSSEEvent(event, 1000 + i, state));
  return state;
}

const chatChunk = (body: Record<string, unknown>): ParsedSSEEvent => ({
  data: JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', model: 'm', ...body }),
});

describe('findStreamFailure: anthropic', () => {
  const start: ParsedSSEEvent = {
    event: 'message_start',
    data: JSON.stringify({
      message: { id: 'msg_1', model: 'claude', usage: { input_tokens: 120, output_tokens: 1 } },
    }),
  };

  it('reports an error event sent inside a 200 stream and keeps observed usage', () => {
    const state = replay(PROVIDERS.anthropic, [
      start,
      {
        event: 'error',
        data: JSON.stringify({
          type: 'error',
          error: { type: 'overloaded_error', message: 'Overloaded' },
        }),
      },
    ]);
    expect(PROVIDERS.anthropic.findStreamFailure(state)).toEqual({
      type: 'overloaded_error',
      message: 'Overloaded',
    });
    expect(PROVIDERS.anthropic.aggregateSSETokens(state)?.promptTokens).toBe(120);
  });

  it('reports an error event that arrives before message_start', () => {
    const state = replay(PROVIDERS.anthropic, [
      {
        event: 'error',
        data: JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'boom' } }),
      },
    ]);
    expect(PROVIDERS.anthropic.findStreamFailure(state)?.type).toBe('api_error');
  });

  it('reports a stream that closes without message_stop as incomplete', () => {
    const state = replay(PROVIDERS.anthropic, [start]);
    expect(PROVIDERS.anthropic.findStreamFailure(state)?.type).toBe('stream_incomplete');
  });
});

describe('findStreamFailure: OpenAI-style', () => {
  it('reports a chat stream that closes without [DONE] as incomplete', () => {
    const state = replay(PROVIDERS.openai, [
      chatChunk({ choices: [{ delta: { content: 'hi' } }] }),
    ]);
    expect(PROVIDERS.openai.findStreamFailure(state)?.type).toBe('stream_incomplete');
  });

  it('does not flag SSE shapes without a known terminal event', () => {
    const state = replay(PROVIDERS.openai, [
      { data: JSON.stringify({ type: 'transcript.text.delta', delta: 'hi' }) },
    ]);
    expect(state.messages).toHaveLength(1);
    expect(PROVIDERS.openai.findStreamFailure(state)).toBeUndefined();
  });

  it('reports an OpenRouter mid-stream error chunk with a numeric code and keeps usage', () => {
    const state = replay(PROVIDERS.openrouter, [
      chatChunk({ choices: [{ delta: { content: 'hi' } }] }),
      chatChunk({
        error: { code: 502, message: 'Provider disconnected' },
        choices: [{ finish_reason: 'error' }],
        usage: { prompt_tokens: 40, completion_tokens: 2, total_tokens: 42 },
      }),
      { data: '[DONE]' },
    ]);
    expect(PROVIDERS.openrouter.findStreamFailure(state)).toEqual({
      type: 'stream_error',
      message: 'Provider disconnected',
      code: '502',
    });
    expect(PROVIDERS.openrouter.aggregateSSETokens(state)?.promptTokens).toBe(40);
  });

  const responsesEvent = (type: string, response: Record<string, unknown>): ParsedSSEEvent => ({
    event: type,
    data: JSON.stringify({ type, response: { object: 'response', ...response } }),
  });

  it('treats a Responses stream that reaches response.completed as healthy', () => {
    const state = replay(PROVIDERS.openai, [
      responsesEvent('response.created', { status: 'in_progress' }),
      { event: 'response.output_text.delta', data: JSON.stringify({ delta: 'hi' }) },
      responsesEvent('response.completed', {
        status: 'completed',
        usage: { input_tokens: 7, output_tokens: 2 },
      }),
    ]);
    expect(PROVIDERS.openai.findStreamFailure(state)).toBeUndefined();
  });

  it('reports a Responses stream cut before its terminal event as incomplete', () => {
    const state = replay(PROVIDERS.openai, [
      responsesEvent('response.created', { status: 'in_progress' }),
      { event: 'response.output_text.delta', data: JSON.stringify({ delta: 'hi' }) },
    ]);
    expect(PROVIDERS.openai.findStreamFailure(state)?.type).toBe('stream_incomplete');
  });

  it('reports an oversized response.failed event', () => {
    const state = replay(PROVIDERS.openai, [
      responsesEvent('response.created', { status: 'in_progress' }),
      responsesEvent('response.failed', {
        status: 'failed',
        instructions: 'x'.repeat(70 * 1024),
        error: { code: 'server_error', message: 'The model failed' },
      }),
    ]);
    expect(PROVIDERS.openai.findStreamFailure(state)?.code).toBe('server_error');
  });

  it('reports a Responses API response.failed event', () => {
    const state = replay(PROVIDERS.openai, [
      {
        event: 'response.created',
        data: JSON.stringify({ type: 'response.created', response: { object: 'response' } }),
      },
      {
        event: 'response.failed',
        data: JSON.stringify({
          type: 'response.failed',
          response: {
            object: 'response',
            status: 'failed',
            error: { code: 'server_error', message: 'The model failed' },
          },
        }),
      },
    ]);
    expect(PROVIDERS.openai.findStreamFailure(state)).toEqual({
      type: 'stream_error',
      message: 'The model failed',
      code: 'server_error',
    });
  });

  it('reports a Responses API error event', () => {
    const state = replay(PROVIDERS.openai, [
      {
        event: 'error',
        data: JSON.stringify({ type: 'error', code: 'rate_limit_exceeded', message: 'Slow down' }),
      },
    ]);
    expect(PROVIDERS.openai.findStreamFailure(state)).toEqual({
      type: 'error',
      message: 'Slow down',
      code: 'rate_limit_exceeded',
    });
  });
});

describe('findStreamFailure: google', () => {
  it('reports an error chunk', () => {
    const state = replay(PROVIDERS.google, [
      {
        data: JSON.stringify({
          error: { code: 500, message: 'Internal error', status: 'INTERNAL' },
        }),
      },
    ]);
    expect(PROVIDERS.google.findStreamFailure(state)).toEqual({
      type: 'INTERNAL',
      message: 'Internal error',
      code: '500',
    });
  });

  it('never reports a missing terminal event, since Gemini streams have none', () => {
    const state = replay(PROVIDERS.google, [
      { data: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] }) },
    ]);
    expect(PROVIDERS.google.findStreamFailure(state)).toBeUndefined();
  });
});
