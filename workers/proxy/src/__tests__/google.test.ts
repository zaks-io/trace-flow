import { describe, it, expect } from 'vitest';
import { parseTokenUsage } from '../parsers/tokens';
import { parseGoogleRequestBody } from '../parsers/request-body';
import { extractGoogleMetadata, extractTokenUsageFromSSEData } from '../parsers/metadata-regex';

describe('Google Gemini API Support', () => {
  describe('Token Parsing', () => {
    it('should parse Google usageMetadata format', () => {
      const response = JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'Hello' }] } }],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 5,
          totalTokenCount: 15,
        },
      });

      const tokens = parseTokenUsage(response);
      expect(tokens).toEqual({
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      });
    });

    it('should parse Google cached content tokens', () => {
      const response = JSON.stringify({
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 50,
          cachedContentTokenCount: 80,
          totalTokenCount: 150,
        },
      });

      const tokens = parseTokenUsage(response);
      expect(tokens?.promptTokens).toBe(100);
      expect(tokens?.completionTokens).toBe(50);
      expect(tokens?.cachedTokens).toBe(80);
      expect(tokens?.totalTokens).toBe(150);
    });

    it('should handle Google response with only prompt tokens', () => {
      const response = JSON.stringify({
        usageMetadata: {
          promptTokenCount: 42,
        },
      });

      const tokens = parseTokenUsage(response);
      expect(tokens?.promptTokens).toBe(42);
      expect(tokens?.completionTokens).toBeUndefined();
    });

    it('should extract Google tokens from SSE data', () => {
      const sseData = JSON.stringify({
        usageMetadata: {
          promptTokenCount: 20,
          candidatesTokenCount: 30,
          totalTokenCount: 50,
        },
      });

      const usage = extractTokenUsageFromSSEData(sseData);
      expect(usage.prompt_token_count).toBe(20);
      expect(usage.candidates_token_count).toBe(30);
      expect(usage.total_token_count).toBe(50);
    });
  });

  describe('Request Body Parsing', () => {
    it('should parse simple contents array', () => {
      const body = JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
      });

      const messages = parseGoogleRequestBody(body);
      expect(messages).not.toBeNull();
      expect(messages).toHaveLength(1);
      expect(messages?.[0]?.role).toBe('user');
      expect(messages?.[0]?.contentBlocks[0]?.type).toBe('text');
    });

    it('should handle systemInstruction', () => {
      const body = JSON.stringify({
        systemInstruction: { parts: [{ text: 'Be helpful' }] },
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
      });

      const messages = parseGoogleRequestBody(body);
      expect(messages).not.toBeNull();
      expect(messages).toHaveLength(2);
      expect(messages?.[0]?.role).toBe('system');
      expect(messages?.[1]?.role).toBe('user');
    });

    it('should map model role to assistant', () => {
      const body = JSON.stringify({
        contents: [
          { role: 'user', parts: [{ text: 'Hello' }] },
          { role: 'model', parts: [{ text: 'Hi there' }] },
        ],
      });

      const messages = parseGoogleRequestBody(body);
      expect(messages).not.toBeNull();
      expect(messages?.[0]?.role).toBe('user');
      expect(messages?.[1]?.role).toBe('assistant');
    });

    it('should handle function calls', () => {
      const body = JSON.stringify({
        contents: [
          {
            role: 'model',
            parts: [{ functionCall: { name: 'getWeather', args: { location: 'SF' } } }],
          },
        ],
      });

      const messages = parseGoogleRequestBody(body);
      expect(messages).not.toBeNull();
      expect(messages?.[0]?.contentBlocks[0]?.type).toBe('tool_call');
      expect(messages?.[0]?.contentBlocks[0]?.toolName).toBe('getWeather');
    });

    it('should handle function responses', () => {
      const body = JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ functionResponse: { name: 'getWeather', response: { temp: 72 } } }],
          },
        ],
      });

      const messages = parseGoogleRequestBody(body);
      expect(messages).not.toBeNull();
      expect(messages?.[0]?.contentBlocks[0]?.type).toBe('tool_result');
      expect(messages?.[0]?.contentBlocks[0]?.toolResultId).toBe('getWeather');
    });

    it('should handle inline data (images)', () => {
      const body = JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ inlineData: { mimeType: 'image/png', data: 'base64...' } }],
          },
        ],
      });

      const messages = parseGoogleRequestBody(body);
      expect(messages).not.toBeNull();
      expect(messages?.[0]?.contentBlocks[0]?.type).toBe('image');
    });

    it('should handle multi-part messages', () => {
      const body = JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: 'Look at this image:' }, { inlineData: { mimeType: 'image/png' } }],
          },
        ],
      });

      const messages = parseGoogleRequestBody(body);
      expect(messages).not.toBeNull();
      expect(messages?.[0]?.contentBlocks).toHaveLength(2);
      expect(messages?.[0]?.contentBlocks[0]?.type).toBe('text');
      expect(messages?.[0]?.contentBlocks[1]?.type).toBe('image');
    });

    it('should return null for invalid body', () => {
      expect(parseGoogleRequestBody('not json')).toBeNull();
      expect(parseGoogleRequestBody('{}')).toBeNull();
      expect(parseGoogleRequestBody('{"messages": []}')).toBeNull();
    });

    it('should default role to user when not specified', () => {
      const body = JSON.stringify({
        contents: [{ parts: [{ text: 'Hello' }] }],
      });

      const messages = parseGoogleRequestBody(body);
      expect(messages).not.toBeNull();
      expect(messages?.[0]?.role).toBe('user');
    });
  });

  describe('Metadata Extraction', () => {
    it('should extract finishReason from Google response', () => {
      const data = JSON.stringify({
        candidates: [{ finishReason: 'STOP', content: {} }],
      });

      const metadata = extractGoogleMetadata(data);
      expect(metadata.finishReason).toBe('STOP');
    });

    it('should extract modelVersion from Google response', () => {
      const data = JSON.stringify({
        modelVersion: 'gemini-2.0-flash-001',
      });

      const metadata = extractGoogleMetadata(data);
      expect(metadata.model).toBe('gemini-2.0-flash-001');
    });

    it('should extract responseId from Google response', () => {
      const data = JSON.stringify({
        responseId: 'abc123xyz',
      });

      const metadata = extractGoogleMetadata(data);
      expect(metadata.id).toBe('abc123xyz');
    });

    it('should accumulate metadata across multiple calls', () => {
      const firstChunk = JSON.stringify({ modelVersion: 'gemini-pro' });
      const lastChunk = JSON.stringify({ candidates: [{ finishReason: 'STOP' }] });

      let metadata = extractGoogleMetadata(firstChunk);
      metadata = extractGoogleMetadata(lastChunk, metadata);

      expect(metadata.model).toBe('gemini-pro');
      expect(metadata.finishReason).toBe('STOP');
    });
  });
});
