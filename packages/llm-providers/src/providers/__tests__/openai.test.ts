import { describe, it, expect } from 'vitest';
import type { SSEStreamData } from '@trace-flow/types';
import { openai } from '../openai';

describe('openai provider — quirks', () => {
  describe('Responses API status → finishReason mapping', () => {
    it('maps response.completed status to finishReason', () => {
      const metadata = openai.parseResponseMetadata(
        JSON.stringify({
          id: 'resp_xyz',
          object: 'response',
          model: 'gpt-4o-2024-08-06',
          status: 'completed',
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      );
      expect(metadata?.finishReason).toBe('completed');
    });

    it('maps response.failed status to finishReason', () => {
      const metadata = openai.parseResponseMetadata(
        JSON.stringify({ object: 'response', status: 'failed' }),
      );
      expect(metadata?.finishReason).toBe('failed');
    });

    it('ignores non-terminal in_progress status', () => {
      const metadata = openai.parseResponseMetadata(
        JSON.stringify({ object: 'response', status: 'in_progress' }),
      );
      expect(metadata?.finishReason).toBeUndefined();
    });

    it('drives Responses API streaming via response.created + response.completed', () => {
      const state: SSEStreamData = { messages: [] };
      openai.handleSSEEvent(
        {
          event: 'response.created',
          data: JSON.stringify({
            type: 'response.created',
            response: { id: 'resp_1', model: 'gpt-4o-2024-08-06', object: 'response' },
          }),
        },
        1000,
        state,
      );
      openai.handleSSEEvent(
        {
          event: 'response.completed',
          data: JSON.stringify({
            type: 'response.completed',
            response: {
              id: 'resp_1',
              status: 'completed',
              usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
            },
          }),
        },
        1010,
        state,
      );
      expect(state.messages[0]?.messageStop).toBe(1010);
      const tokens = openai.aggregateSSETokens(state);
      expect(tokens?.promptTokens).toBe(10);
      expect(tokens?.completionTokens).toBe(5);
    });
  });

  describe('Chat Completions [DONE] terminator', () => {
    it('sets messageStop on [DONE]', () => {
      const state: SSEStreamData = { messages: [] };
      openai.handleSSEEvent(
        {
          data: JSON.stringify({
            id: 'c1',
            object: 'chat.completion.chunk',
            model: 'gpt-4o-mini',
            choices: [{ delta: { content: 'hi' } }],
          }),
        },
        1000,
        state,
      );
      openai.handleSSEEvent({ data: '[DONE]' }, 1100, state);
      expect(state.messages[0]?.messageStop).toBe(1100);
    });
  });

  describe('tool_calls request roundtrip', () => {
    it('parses assistant tool_calls into tool_call blocks', () => {
      const messages = openai.parseRequestBody(
        JSON.stringify({
          messages: [
            { role: 'user', content: 'weather?' },
            {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'get_weather', arguments: '{}' },
                },
              ],
            },
            { role: 'tool', tool_call_id: 'call_1', content: '72F' },
          ],
        }),
      );
      expect(messages).toHaveLength(3);
      expect(messages?.[1]?.contentBlocks[0]?.type).toBe('tool_call');
      expect(messages?.[1]?.contentBlocks[0]?.toolUseId).toBe('call_1');
      const toolResultBlock = messages?.[2]?.contentBlocks.find((b) => b.type === 'tool_result');
      expect(toolResultBlock?.toolResultId).toBe('call_1');
    });
  });

  describe('multimodal content arrays', () => {
    it('maps text + image_url parts to separate content blocks', () => {
      const messages = openai.parseRequestBody(
        JSON.stringify({
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'what is this?' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBOR...' } },
              ],
            },
          ],
        }),
      );
      expect(messages?.[0]?.contentBlocks).toHaveLength(2);
      expect(messages?.[0]?.contentBlocks[0]?.type).toBe('text');
      expect(messages?.[0]?.contentBlocks[1]?.type).toBe('image');
    });

    it('captures audio-only messages as a text block so they are not dropped', () => {
      const messages = openai.parseRequestBody(
        JSON.stringify({
          messages: [
            {
              role: 'user',
              content: [{ type: 'input_audio', input_audio: { data: 'AAAA', format: 'wav' } }],
            },
          ],
        }),
      );
      expect(messages).toHaveLength(1);
      expect(messages?.[0]?.contentBlocks).toHaveLength(1);
      expect(messages?.[0]?.contentBlocks[0]?.type).toBe('text');
    });
  });

  describe('cached_tokens → cacheReadTokens', () => {
    it('extracts prompt cache reads', () => {
      const tokens = openai.parseResponseTokenUsage(
        JSON.stringify({
          usage: {
            prompt_tokens: 100,
            completion_tokens: 50,
            total_tokens: 150,
            prompt_tokens_details: { cached_tokens: 80 },
          },
        }),
      );
      expect(tokens?.cacheReadTokens).toBe(80);
    });
  });
});
