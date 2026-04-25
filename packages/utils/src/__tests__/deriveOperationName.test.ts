import { describe, it, expect } from 'vitest';
import { deriveOperationName } from '../index';

describe('deriveOperationName', () => {
  describe('OpenAI patterns', () => {
    it('should identify chat completions', () => {
      expect(deriveOperationName('/openai/v1/chat/completions')).toBe('chat');
      expect(deriveOperationName('/v1/chat/completions')).toBe('chat');
    });

    it('should identify text completions', () => {
      expect(deriveOperationName('/openai/v1/completions')).toBe('text_completion');
      expect(deriveOperationName('/v1/completions')).toBe('text_completion');
    });

    it('should identify embeddings', () => {
      expect(deriveOperationName('/openai/v1/embeddings')).toBe('embeddings');
      expect(deriveOperationName('/v1/embeddings')).toBe('embeddings');
    });
  });

  describe('Anthropic patterns', () => {
    it('should identify messages as chat', () => {
      expect(deriveOperationName('/anthropic/v1/messages')).toBe('chat');
      expect(deriveOperationName('/v1/messages')).toBe('chat');
    });
  });

  describe('Google Gemini patterns', () => {
    it('should identify generateContent as chat', () => {
      expect(deriveOperationName('/google/v1beta/models/gemini-pro:generateContent')).toBe('chat');
      expect(deriveOperationName('/v1beta/models/gemini-1.5-flash:generateContent')).toBe('chat');
    });

    it('should identify streamGenerateContent as chat', () => {
      expect(
        deriveOperationName('/google/v1beta/models/gemini-2.0-flash:streamGenerateContent'),
      ).toBe('chat');
    });

    it('should identify embedContent', () => {
      expect(deriveOperationName('/google/v1beta/models/text-embedding-004:embedContent')).toBe(
        'embeddings',
      );
      expect(deriveOperationName('/v1/models/embedding-001:embedContent')).toBe('embeddings');
    });

    it('should identify batchEmbedContents', () => {
      expect(
        deriveOperationName('/google/v1beta/models/gemini-embedding-001:batchEmbedContents'),
      ).toBe('embeddings');
      expect(deriveOperationName('/v1beta/models/embedding-001:batchEmbedContents')).toBe(
        'embeddings',
      );
    });
  });

  describe('Groq patterns (OpenAI-compatible)', () => {
    it('should identify chat completions', () => {
      expect(deriveOperationName('/groq/openai/v1/chat/completions')).toBe('chat');
    });

    it('should identify embeddings', () => {
      expect(deriveOperationName('/groq/openai/v1/embeddings')).toBe('embeddings');
    });
  });

  describe('OpenRouter patterns (OpenAI-compatible)', () => {
    it('should identify chat completions', () => {
      expect(deriveOperationName('/openrouter/api/v1/chat/completions')).toBe('chat');
    });
  });

  describe('case insensitivity', () => {
    it('should handle uppercase paths', () => {
      expect(deriveOperationName('/OpenAI/V1/Chat/Completions')).toBe('chat');
      expect(deriveOperationName('/V1/EMBEDDINGS')).toBe('embeddings');
      expect(deriveOperationName('/GOOGLE/V1BETA/MODELS/GEMINI:GENERATECONTENT')).toBe('chat');
    });

    it('should handle mixed case paths', () => {
      expect(deriveOperationName('/v1/Chat/COMPLETIONS')).toBe('chat');
      expect(deriveOperationName('/Anthropic/V1/Messages')).toBe('chat');
    });
  });

  describe('default fallback', () => {
    it('should return chat for unknown paths', () => {
      expect(deriveOperationName('/unknown/api/endpoint')).toBe('chat');
      expect(deriveOperationName('/custom/path')).toBe('chat');
      expect(deriveOperationName('/')).toBe('chat');
      expect(deriveOperationName('')).toBe('chat');
    });
  });

  describe('edge cases', () => {
    it('should not confuse chat/completions with just completions', () => {
      expect(deriveOperationName('/v1/chat/completions')).toBe('chat');
      expect(deriveOperationName('/v1/completions')).toBe('text_completion');
    });

    it('should handle paths with query parameters', () => {
      expect(deriveOperationName('/v1/chat/completions?key=value')).toBe('chat');
    });
  });
});
