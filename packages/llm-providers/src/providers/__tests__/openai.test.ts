import { describe, it, expect } from 'vitest';
import type { SSEStreamData } from '@trace-flow/types';
import { openai } from '../openai';
import { MAX_SSE_EVENT_DATA_LENGTH } from '../sse-state';

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

    it('scans an oversized terminal event without retaining its output', () => {
      const state: SSEStreamData = { messages: [] };
      openai.handleSSEEvent(
        {
          event: 'response.created',
          data: JSON.stringify({
            type: 'response.created',
            response: { id: 'resp_large', object: 'response' },
          }),
        },
        1000,
        state,
      );

      const canary = `OPENAI_RESPONSES_RAW_CANARY${'x'.repeat(MAX_SSE_EVENT_DATA_LENGTH)}`;
      openai.handleSSEEvent(
        {
          event: 'response.completed',
          data: JSON.stringify({
            type: 'response.completed',
            response: {
              output: [{ content: [{ type: 'output_text', text: canary }] }],
              status: 'completed',
              usage: { input_tokens: 144, output_tokens: 55 },
            },
          }),
        },
        1100,
        state,
      );

      expect(state.messages[0]?.metadata?.finishReason).toBe('completed');
      expect(state.messages[0]?.messageStop).toBe(1100);
      expect(openai.aggregateSSETokens(state)).toMatchObject({
        promptTokens: 144,
        completionTokens: 55,
      });
      expect(JSON.stringify(state)).not.toContain('OPENAI_RESPONSES_RAW_CANARY');
    });

    it('ignores oversized non-summary Responses API events', () => {
      const state: SSEStreamData = { messages: [] };
      const canary = `OPENAI_DELTA_RAW_CANARY${'x'.repeat(MAX_SSE_EVENT_DATA_LENGTH)}`;

      openai.handleSSEEvent(
        {
          event: 'response.output_text.delta',
          data: JSON.stringify({
            type: 'response.output_text.delta',
            delta: canary,
            usage: { input_tokens: 999, output_tokens: 999 },
          }),
        },
        1000,
        state,
      );

      expect(state.messages).toEqual([]);
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

    it('scans final usage from an oversized chat frame', () => {
      const state: SSEStreamData = { messages: [] };
      openai.handleSSEEvent(
        { data: JSON.stringify({ id: 'chat_large', choices: [{ delta: { content: 'hi' } }] }) },
        1000,
        state,
      );

      const canary = `OPENAI_CHAT_RAW_CANARY${'x'.repeat(MAX_SSE_EVENT_DATA_LENGTH)}`;
      openai.handleSSEEvent(
        {
          data: JSON.stringify({
            choices: [{ delta: { content: canary }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 89, completion_tokens: 13 },
          }),
        },
        1050,
        state,
      );
      openai.handleSSEEvent({ data: '[DONE]' }, 1100, state);

      expect(state.messages[0]?.metadata?.finishReason).toBe('stop');
      expect(state.messages[0]?.messageStop).toBe(1100);
      expect(openai.aggregateSSETokens(state)).toMatchObject({
        promptTokens: 89,
        completionTokens: 13,
      });
      expect(JSON.stringify(state)).not.toContain('OPENAI_CHAT_RAW_CANARY');
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

  describe('bounded scalar scanning', () => {
    it('does not retain overlong metadata or text-valued refusal and reasoning fields', () => {
      const canary = 'OPENAI_SCALAR_RAW_CANARY';
      const metadata = openai.parseResponseMetadata(
        JSON.stringify({
          id: 'i'.repeat(257),
          model: '😀'.repeat(65),
          refusal: `${canary}${'r'.repeat(300)}`,
          reasoning: `${canary}${'t'.repeat(300)}`,
        }),
      );

      expect(metadata).toEqual({ hasRefusal: true, hasReasoning: true });
      expect(JSON.stringify(metadata)).not.toContain(canary);
    });

    it('does not accept token counters longer than 20 digits', () => {
      const state: SSEStreamData = { messages: [] };
      openai.handleSSEEvent(
        {
          data:
            '{"choices":[],"usage":{"prompt_tokens":123456789012345678901,' +
            '"completion_tokens":123456789012345678901}}',
        },
        1000,
        state,
      );

      expect(openai.aggregateSSETokens(state)).toBeUndefined();
    });
  });
});
