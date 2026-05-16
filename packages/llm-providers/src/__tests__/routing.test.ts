import { describe, it, expect } from 'vitest';
import { resolveRoute, PROVIDERS } from '../routing';

describe('Provider Routing', () => {
  describe('resolveRoute', () => {
    it('should resolve OpenAI route with full path', () => {
      const result = resolveRoute('/openai/v1/chat/completions');
      expect(result).not.toBeNull();
      expect(result!.provider.id).toBe('openai');
      expect(result!.targetUrl).toBe('https://api.openai.com/v1/chat/completions');
    });

    it('should resolve Anthropic route with full path', () => {
      const result = resolveRoute('/anthropic/v1/messages');
      expect(result).not.toBeNull();
      expect(result!.provider.id).toBe('anthropic');
      expect(result!.targetUrl).toBe('https://api.anthropic.com/v1/messages');
    });

    it('should resolve OpenRouter route with full path', () => {
      const result = resolveRoute('/openrouter/v1/chat/completions');
      expect(result).not.toBeNull();
      expect(result!.provider.id).toBe('openrouter');
      expect(result!.targetUrl).toBe('https://openrouter.ai/api/v1/chat/completions');
    });

    it('should resolve Groq route with full path', () => {
      const result = resolveRoute('/groq/v1/chat/completions');
      expect(result).not.toBeNull();
      expect(result!.provider.id).toBe('groq');
      expect(result!.targetUrl).toBe('https://api.groq.com/openai/v1/chat/completions');
    });

    it('should resolve Google route with generateContent path', () => {
      const result = resolveRoute('/google/v1beta/models/gemini-pro:generateContent');
      expect(result).not.toBeNull();
      expect(result!.provider.id).toBe('google');
      expect(result!.targetUrl).toBe(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent',
      );
    });

    it('should resolve Google route with streamGenerateContent path', () => {
      const result = resolveRoute('/google/v1beta/models/gemini-2.0-flash:streamGenerateContent');
      expect(result).not.toBeNull();
      expect(result!.provider.id).toBe('google');
      expect(result!.targetUrl).toBe(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent',
      );
    });

    it('should handle provider path with no sub-path', () => {
      const result = resolveRoute('/openai');
      expect(result).not.toBeNull();
      expect(result!.provider.id).toBe('openai');
      expect(result!.targetUrl).toBe('https://api.openai.com');
    });

    it('should handle nested paths', () => {
      const result = resolveRoute('/openai/v1/models/gpt-4');
      expect(result).not.toBeNull();
      expect(result!.targetUrl).toBe('https://api.openai.com/v1/models/gpt-4');
    });

    it('should be case-insensitive for provider names', () => {
      const result = resolveRoute('/OpenAI/v1/chat/completions');
      expect(result).not.toBeNull();
      expect(result!.provider.id).toBe('openai');
    });

    it('should return null for unknown provider', () => {
      const result = resolveRoute('/unknown/v1/messages');
      expect(result).toBeNull();
    });

    it('should return null for invalid path format', () => {
      expect(resolveRoute('/')).toBeNull();
    });
  });

  describe('PROVIDERS config', () => {
    it('should have correct base URLs', () => {
      expect(PROVIDERS.openai.baseUrl).toBe('https://api.openai.com');
      expect(PROVIDERS.anthropic.baseUrl).toBe('https://api.anthropic.com');
      expect(PROVIDERS.openrouter.baseUrl).toBe('https://openrouter.ai/api');
      expect(PROVIDERS.groq.baseUrl).toBe('https://api.groq.com/openai');
      expect(PROVIDERS.google.baseUrl).toBe('https://generativelanguage.googleapis.com');
    });
  });
});
