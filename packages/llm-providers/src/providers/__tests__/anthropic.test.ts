import { describe, it, expect } from 'vitest';
import type { SSEStreamData } from '@trace-flow/types';
import { anthropic } from '../anthropic';

describe('anthropic provider — quirks', () => {
  describe('thinking-delta length accumulation', () => {
    it('accumulates thinkingTextLength across thinking_delta events', () => {
      const state: SSEStreamData = { messages: [] };

      anthropic.handleSSEEvent(
        {
          event: 'message_start',
          data: JSON.stringify({
            message: { id: 'msg_1', model: 'claude-opus-4-7', usage: { input_tokens: 10 } },
          }),
        },
        1000,
        state,
      );
      anthropic.handleSSEEvent(
        {
          event: 'content_block_start',
          data: JSON.stringify({ index: 0, content_block: { type: 'thinking' } }),
        },
        1001,
        state,
      );
      anthropic.handleSSEEvent(
        {
          event: 'content_block_delta',
          data: JSON.stringify({
            index: 0,
            delta: { type: 'thinking_delta', thinking: 'Hmm' },
          }),
        },
        1002,
        state,
      );
      anthropic.handleSSEEvent(
        {
          event: 'content_block_delta',
          data: JSON.stringify({
            index: 0,
            delta: { type: 'thinking_delta', thinking: ' let me think' },
          }),
        },
        1003,
        state,
      );

      const block = state.messages[0]?.contentBlocks?.[0];
      expect(block?.type).toBe('thinking');
      expect(block?.thinkingTextLength).toBe('Hmm'.length + ' let me think'.length);
    });
  });

  describe('content block typing', () => {
    it('records tool_use blocks with toolUseId and toolName', () => {
      const state: SSEStreamData = { messages: [] };
      anthropic.handleSSEEvent(
        {
          event: 'message_start',
          data: JSON.stringify({ message: { id: 'm', model: 'x', usage: { input_tokens: 1 } } }),
        },
        1,
        state,
      );
      anthropic.handleSSEEvent(
        {
          event: 'content_block_start',
          data: JSON.stringify({
            index: 0,
            content_block: { type: 'tool_use', id: 'toolu_abc', name: 'get_weather' },
          }),
        },
        2,
        state,
      );
      anthropic.handleSSEEvent(
        { event: 'content_block_stop', data: JSON.stringify({ index: 0 }) },
        3,
        state,
      );

      const block = state.messages[0]?.contentBlocks?.[0];
      expect(block?.type).toBe('tool_use');
      expect(block?.toolUseId).toBe('toolu_abc');
      expect(block?.toolName).toBe('get_weather');
      expect(block?.stopTimestamp).toBe(3);
    });
  });

  describe('request body parsing', () => {
    it('handles system as string', () => {
      const messages = anthropic.parseRequestBody(
        JSON.stringify({
          system: 'You are helpful',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      );
      expect(messages).toHaveLength(2);
      expect(messages?.[0]?.role).toBe('system');
    });

    it('extracts tool_use and tool_result content blocks from assistant turns', () => {
      const messages = anthropic.parseRequestBody(
        JSON.stringify({
          messages: [
            { role: 'user', content: 'weather?' },
            {
              role: 'assistant',
              content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} }],
            },
            {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '72F' }],
            },
          ],
        }),
      );
      expect(messages).toHaveLength(3);
      expect(messages?.[1]?.contentBlocks[0]?.type).toBe('tool_use');
      expect(messages?.[1]?.contentBlocks[0]?.toolUseId).toBe('toolu_1');
      expect(messages?.[2]?.contentBlocks[0]?.type).toBe('tool_result');
      expect(messages?.[2]?.contentBlocks[0]?.toolResultId).toBe('toolu_1');
    });
  });

  describe('metadata extraction', () => {
    it('captures stop_reason and stop_sequence', () => {
      const metadata = anthropic.parseResponseMetadata(
        JSON.stringify({
          id: 'msg_1',
          model: 'claude-opus-4-7',
          stop_reason: 'end_turn',
          stop_sequence: null,
        }),
      );
      expect(metadata?.stopReason).toBe('end_turn');
    });
  });

  describe('messageStop semantics', () => {
    it('sets messageStop on message_stop event', () => {
      const state: SSEStreamData = { messages: [] };
      anthropic.handleSSEEvent(
        {
          event: 'message_start',
          data: JSON.stringify({ message: { id: 'm', model: 'x', usage: { input_tokens: 1 } } }),
        },
        1,
        state,
      );
      anthropic.handleSSEEvent({ event: 'message_stop', data: '{}' }, 5, state);
      expect(state.messages[0]?.messageStop).toBe(5);
    });
  });
});
