import { describe, it, expect } from 'vitest';
import type { SSEStreamData } from '@trace-flow/types';
import { google } from '../google';

describe('google provider — quirks', () => {
  describe('lastMatchOnly cumulative usageMetadata', () => {
    it('uses the final chunk usage (last-wins) rather than summing', () => {
      const state: SSEStreamData = { messages: [] };
      // Gemini ships cumulative usageMetadata in every chunk; only the final value matters.
      google.handleSSEEvent(
        {
          data: JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'hi' }] } }],
            modelVersion: 'gemini-2.0-flash-001',
            usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1, totalTokenCount: 6 },
          }),
        },
        1000,
        state,
      );
      google.handleSSEEvent(
        {
          data: JSON.stringify({
            candidates: [{ content: { parts: [{ text: ' there' }] } }],
            usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
          }),
        },
        1010,
        state,
      );
      google.handleSSEEvent(
        {
          data: JSON.stringify({
            candidates: [{ finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 7, totalTokenCount: 12 },
          }),
        },
        1020,
        state,
      );

      const tokens = google.aggregateSSETokens(state);
      expect(tokens?.promptTokens).toBe(5);
      expect(tokens?.completionTokens).toBe(7);
      expect(tokens?.totalTokens).toBe(12);
    });
  });

  describe('parseResponseMetadata URL fallback', () => {
    it('falls back to model in URL path when body omits modelVersion', () => {
      const metadata = google.parseResponseMetadata(
        JSON.stringify({ embedding: { values: [0.1, 0.2] } }),
        {
          targetUrl:
            'https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent',
        },
      );
      expect(metadata?.model).toBe('text-embedding-004');
    });

    it('prefers modelVersion from body when present', () => {
      const metadata = google.parseResponseMetadata(
        JSON.stringify({ modelVersion: 'gemini-2.0-flash-001' }),
        {
          targetUrl:
            'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
        },
      );
      expect(metadata?.model).toBe('gemini-2.0-flash-001');
    });

    it('returns undefined when both body and URL are empty', () => {
      expect(google.parseResponseMetadata('{}')).toBeUndefined();
    });

    it('ignores malformed targetUrl', () => {
      const metadata = google.parseResponseMetadata(JSON.stringify({ responseId: 'res_xyz' }), {
        targetUrl: 'not a url',
      });
      expect(metadata?.id).toBe('res_xyz');
      expect(metadata?.model).toBeUndefined();
    });
  });

  describe('thoughtsTokenCount → reasoningTokens', () => {
    it('maps Gemini thinking tokens', () => {
      const tokens = google.parseResponseTokenUsage(
        JSON.stringify({
          usageMetadata: {
            promptTokenCount: 50,
            candidatesTokenCount: 200,
            totalTokenCount: 250,
            thoughtsTokenCount: 150,
          },
        }),
      );
      expect(tokens?.reasoningTokens).toBe(150);
    });
  });

  describe('cachedContentTokenCount → cacheReadTokens', () => {
    it('exposes cache reads', () => {
      const tokens = google.parseResponseTokenUsage(
        JSON.stringify({
          usageMetadata: {
            promptTokenCount: 100,
            candidatesTokenCount: 50,
            cachedContentTokenCount: 80,
            totalTokenCount: 150,
          },
        }),
      );
      expect(tokens?.cacheReadTokens).toBe(80);
    });
  });

  describe('request body parsing', () => {
    it('maps "model" role to "assistant"', () => {
      const messages = google.parseRequestBody(
        JSON.stringify({
          contents: [
            { role: 'user', parts: [{ text: 'hi' }] },
            { role: 'model', parts: [{ text: 'hello' }] },
          ],
        }),
      );
      expect(messages?.[0]?.role).toBe('user');
      expect(messages?.[1]?.role).toBe('assistant');
    });

    it('handles systemInstruction', () => {
      const messages = google.parseRequestBody(
        JSON.stringify({
          systemInstruction: { parts: [{ text: 'Be helpful' }] },
          contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        }),
      );
      expect(messages).toHaveLength(2);
      expect(messages?.[0]?.role).toBe('system');
    });

    it('handles functionCall and functionResponse parts', () => {
      const messages = google.parseRequestBody(
        JSON.stringify({
          contents: [
            {
              role: 'model',
              parts: [
                { functionCall: { id: 'call_abc', name: 'getWeather', args: { location: 'SF' } } },
              ],
            },
            {
              role: 'user',
              parts: [
                {
                  functionResponse: {
                    id: 'call_abc',
                    name: 'getWeather',
                    response: { temp: 72 },
                  },
                },
              ],
            },
          ],
        }),
      );
      expect(messages?.[0]?.contentBlocks[0]?.type).toBe('tool_call');
      expect(messages?.[0]?.contentBlocks[0]?.toolName).toBe('getWeather');
      expect(messages?.[0]?.contentBlocks[0]?.toolUseId).toBe('call_abc');
      expect(messages?.[1]?.contentBlocks[0]?.type).toBe('tool_result');
      expect(messages?.[1]?.contentBlocks[0]?.toolResultId).toBe('call_abc');
    });

    it('falls back to function name when functionResponse has no id', () => {
      const messages = google.parseRequestBody(
        JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [{ functionResponse: { name: 'getWeather', response: { temp: 72 } } }],
            },
          ],
        }),
      );
      expect(messages?.[0]?.contentBlocks[0]?.toolResultId).toBe('getWeather');
    });

    it('handles inlineData (image) parts', () => {
      const messages = google.parseRequestBody(
        JSON.stringify({
          contents: [
            { role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'b64' } }] },
          ],
        }),
      );
      expect(messages?.[0]?.contentBlocks[0]?.type).toBe('image');
    });

    it('returns null for empty/invalid bodies', () => {
      expect(google.parseRequestBody('{}')).toBeNull();
      expect(google.parseRequestBody('{"messages": []}')).toBeNull();
    });
  });
});
