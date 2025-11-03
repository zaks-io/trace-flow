import { describe, it, expect } from 'vitest';
import { detectProvider, injectProviderAuth, ProviderAuthType } from '../providers';

describe('Provider Detection and Auth Injection', () => {
  describe('detectProvider', () => {
    it('should detect Anthropic provider', () => {
      const config = detectProvider('https://api.anthropic.com/v1/messages');
      expect(config.authType).toBe(ProviderAuthType.X_API_KEY);
    });

    it('should detect OpenAI provider', () => {
      const config = detectProvider('https://api.openai.com/v1/chat/completions');
      expect(config.authType).toBe(ProviderAuthType.BEARER);
    });

    it('should detect OpenRouter provider', () => {
      const config = detectProvider('https://openrouter.ai/api/v1/chat/completions');
      expect(config.authType).toBe(ProviderAuthType.BEARER);
    });

    it('should default to Bearer for unknown providers', () => {
      const config = detectProvider('https://api.unknown.com/v1/endpoint');
      expect(config.authType).toBe(ProviderAuthType.BEARER);
    });

    it('should handle invalid URLs gracefully', () => {
      const config = detectProvider('not-a-url');
      expect(config.authType).toBe(ProviderAuthType.BEARER);
    });
  });

  describe('injectProviderAuth', () => {
    it('should inject x-api-key header for Anthropic', () => {
      const headers = new Headers();
      injectProviderAuth(headers, 'test-anthropic-key', 'https://api.anthropic.com/v1/messages');

      expect(headers.get('x-api-key')).toBe('test-anthropic-key');
      expect(headers.get('Authorization')).toBeNull();
    });

    it('should inject Bearer token for OpenAI', () => {
      const headers = new Headers();
      injectProviderAuth(headers, 'test-openai-key', 'https://api.openai.com/v1/chat/completions');

      expect(headers.get('Authorization')).toBe('Bearer test-openai-key');
      expect(headers.get('x-api-key')).toBeNull();
    });

    it('should inject Bearer token for OpenRouter', () => {
      const headers = new Headers();
      injectProviderAuth(
        headers,
        'test-openrouter-key',
        'https://openrouter.ai/api/v1/chat/completions',
      );

      expect(headers.get('Authorization')).toBe('Bearer test-openrouter-key');
      expect(headers.get('x-api-key')).toBeNull();
    });

    it('should inject Bearer token for unknown providers', () => {
      const headers = new Headers();
      injectProviderAuth(headers, 'test-key', 'https://api.unknown.com/v1/endpoint');

      expect(headers.get('Authorization')).toBe('Bearer test-key');
      expect(headers.get('x-api-key')).toBeNull();
    });

    it('should replace existing auth headers', () => {
      const headers = new Headers();
      headers.set('Authorization', 'Bearer old-key');

      injectProviderAuth(headers, 'new-key', 'https://api.openai.com/v1/chat/completions');

      expect(headers.get('Authorization')).toBe('Bearer new-key');
    });

    it('should replace x-api-key if it exists', () => {
      const headers = new Headers();
      headers.set('x-api-key', 'old-key');

      injectProviderAuth(headers, 'new-key', 'https://api.anthropic.com/v1/messages');

      expect(headers.get('x-api-key')).toBe('new-key');
    });
  });
});
