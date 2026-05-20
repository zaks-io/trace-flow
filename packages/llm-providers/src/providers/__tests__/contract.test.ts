import { describe, it, expect } from 'vitest';
import type { SSEStreamData } from '@trace-flow/types';
import { PROVIDERS } from '../index';

/**
 * Contract test: every Provider adapter must satisfy the same surface contract.
 *
 * The fixtures below mirror minimum-viable shapes for each Provider — they're
 * not comprehensive payloads, they're the smallest input that exercises each
 * method on the interface. Provider-specific quirks (Anthropic thinking deltas,
 * Google lastMatchOnly, OpenRouter cost) live in per-Provider test files.
 */

interface ProviderFixture {
  requestBody: string;
  responseBody: string;
  streamEvents: { event?: string; data: string; timestamp: number }[];
  expectedPromptTokens: number;
  expectedCompletionTokens: number;
  expectedModel: string;
}

const FIXTURES: Record<string, ProviderFixture> = {
  openai: {
    requestBody: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    }),
    responseBody: JSON.stringify({
      id: 'chatcmpl-xyz',
      object: 'chat.completion',
      created: 1_700_000_000,
      model: 'gpt-4o-mini',
      choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    }),
    streamEvents: [
      {
        data: JSON.stringify({
          id: 'chatcmpl-xyz',
          object: 'chat.completion.chunk',
          model: 'gpt-4o-mini',
          choices: [{ delta: { content: 'hi' } }],
        }),
        timestamp: 1000,
      },
      {
        data: JSON.stringify({
          choices: [{ finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        }),
        timestamp: 1010,
      },
      { data: '[DONE]', timestamp: 1020 },
    ],
    expectedPromptTokens: 5,
    expectedCompletionTokens: 3,
    expectedModel: 'gpt-4o-mini',
  },
  anthropic: {
    requestBody: JSON.stringify({
      model: 'claude-3-5-sonnet-20241022',
      messages: [{ role: 'user', content: 'hi' }],
    }),
    responseBody: JSON.stringify({
      id: 'msg_abc',
      model: 'claude-3-5-sonnet-20241022',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'hello' }],
      usage: { input_tokens: 5, output_tokens: 3 },
    }),
    streamEvents: [
      {
        event: 'message_start',
        data: JSON.stringify({
          message: {
            id: 'msg_abc',
            model: 'claude-3-5-sonnet-20241022',
            usage: { input_tokens: 5, output_tokens: 0 },
          },
        }),
        timestamp: 1000,
      },
      {
        event: 'message_delta',
        data: JSON.stringify({
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 3 },
        }),
        timestamp: 1010,
      },
      { event: 'message_stop', data: '{}', timestamp: 1020 },
    ],
    expectedPromptTokens: 5,
    expectedCompletionTokens: 3,
    expectedModel: 'claude-3-5-sonnet-20241022',
  },
  google: {
    requestBody: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    }),
    responseBody: JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'hello' }] }, finishReason: 'STOP' }],
      modelVersion: 'gemini-2.0-flash-001',
      responseId: 'res_xyz',
      usageMetadata: {
        promptTokenCount: 5,
        candidatesTokenCount: 3,
        totalTokenCount: 8,
      },
    }),
    streamEvents: [
      {
        data: JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'hi' }] } }],
          modelVersion: 'gemini-2.0-flash-001',
          responseId: 'res_xyz',
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
        }),
        timestamp: 1000,
      },
      {
        data: JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'lo' }] }, finishReason: 'STOP' }],
          modelVersion: 'gemini-2.0-flash-001',
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
        }),
        timestamp: 1010,
      },
    ],
    expectedPromptTokens: 5,
    expectedCompletionTokens: 3,
    expectedModel: 'gemini-2.0-flash-001',
  },
  openrouter: {
    requestBody: JSON.stringify({
      model: 'openai/gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    }),
    responseBody: JSON.stringify({
      id: 'gen-xyz',
      object: 'chat.completion',
      model: 'openai/gpt-4o-mini',
      created: 1_700_000_000,
      choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8, cost: 0.000123 },
    }),
    streamEvents: [
      {
        data: JSON.stringify({
          id: 'gen-xyz',
          object: 'chat.completion.chunk',
          model: 'openai/gpt-4o-mini',
          choices: [{ delta: { content: 'hi' } }],
        }),
        timestamp: 1000,
      },
      {
        data: JSON.stringify({
          choices: [{ finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8, cost: 0.000123 },
        }),
        timestamp: 1010,
      },
      { data: '[DONE]', timestamp: 1020 },
    ],
    expectedPromptTokens: 5,
    expectedCompletionTokens: 3,
    expectedModel: 'openai/gpt-4o-mini',
  },
  groq: {
    requestBody: JSON.stringify({
      model: 'llama-3.1-70b-versatile',
      messages: [{ role: 'user', content: 'hi' }],
    }),
    responseBody: JSON.stringify({
      id: 'chatcmpl-grq',
      object: 'chat.completion',
      model: 'llama-3.1-70b-versatile',
      created: 1_700_000_000,
      choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    }),
    streamEvents: [
      {
        data: JSON.stringify({
          id: 'chatcmpl-grq',
          object: 'chat.completion.chunk',
          model: 'llama-3.1-70b-versatile',
          choices: [{ delta: { content: 'hi' } }],
        }),
        timestamp: 1000,
      },
      {
        data: JSON.stringify({
          choices: [{ finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        }),
        timestamp: 1010,
      },
      { data: '[DONE]', timestamp: 1020 },
    ],
    expectedPromptTokens: 5,
    expectedCompletionTokens: 3,
    expectedModel: 'llama-3.1-70b-versatile',
  },
};

describe.each(Object.entries(PROVIDERS))('Provider contract: %s', (id, provider) => {
  const fixture = FIXTURES[id];
  if (!fixture) throw new Error(`Missing fixture for ${id}`);

  it('exposes id, baseUrl, and tokenSchema', () => {
    expect(provider.id).toBe(id);
    expect(provider.baseUrl).toMatch(/^https?:\/\//);
    expect(provider.tokenSchema).toBeDefined();
  });

  it('parses request body into InputMessages', () => {
    const messages = provider.parseRequestBody(fixture.requestBody);
    expect(messages).not.toBeNull();
    expect(messages?.length).toBeGreaterThan(0);
    const userMsg = messages?.find((m) => m.role === 'user');
    expect(userMsg).toBeDefined();
  });

  it('returns null for malformed request body', () => {
    expect(provider.parseRequestBody('not json')).toBeNull();
  });

  it('extracts response metadata from whole-body response', () => {
    const metadata = provider.parseResponseMetadata(fixture.responseBody);
    expect(metadata).toBeDefined();
    expect(metadata?.model).toBe(fixture.expectedModel);
  });

  it('extracts token usage from whole-body response', () => {
    const tokens = provider.parseResponseTokenUsage(fixture.responseBody);
    expect(tokens).toBeDefined();
    expect(tokens?.promptTokens).toBe(fixture.expectedPromptTokens);
    expect(tokens?.completionTokens).toBe(fixture.expectedCompletionTokens);
  });

  it('drives SSE state forward via handleSSEEvent + aggregates tokens', () => {
    const state: SSEStreamData = { messages: [] };
    for (const event of fixture.streamEvents) {
      provider.handleSSEEvent(event, event.timestamp, state);
    }
    expect(state.messages.length).toBeGreaterThan(0);

    const tokens = provider.aggregateSSETokens(state);
    expect(tokens).toBeDefined();
    expect(tokens?.promptTokens).toBe(fixture.expectedPromptTokens);
    expect(tokens?.completionTokens).toBe(fixture.expectedCompletionTokens);
  });

  it('aggregateSSETokens returns undefined for empty stream', () => {
    expect(provider.aggregateSSETokens({ messages: [] })).toBeUndefined();
  });
});
