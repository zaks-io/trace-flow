import { describe, it, expect } from 'vitest';
import { extractProviderFromUrl } from '../index';

describe('extractProviderFromUrl', () => {
  describe('OpenAI', () => {
    it('should identify OpenAI URLs', () => {
      expect(extractProviderFromUrl('https://api.openai.com/v1/chat/completions')).toBe('openai');
      expect(extractProviderFromUrl('https://api.openai.com/v1/completions')).toBe('openai');
      expect(extractProviderFromUrl('https://OPENAI.COM/api')).toBe('openai');
    });
  });

  describe('Anthropic', () => {
    it('should identify Anthropic URLs', () => {
      expect(extractProviderFromUrl('https://api.anthropic.com/v1/messages')).toBe('anthropic');
      expect(extractProviderFromUrl('https://ANTHROPIC.COM/api')).toBe('anthropic');
    });
  });

  describe('OpenRouter', () => {
    it('should identify OpenRouter URLs', () => {
      expect(extractProviderFromUrl('https://openrouter.ai/api/v1/chat/completions')).toBe(
        'openrouter',
      );
      expect(extractProviderFromUrl('https://OPENROUTER.AI/api')).toBe('openrouter');
    });
  });

  describe('Google', () => {
    it('should identify Google URLs', () => {
      expect(extractProviderFromUrl('https://generativelanguage.googleapis.com/v1/models')).toBe(
        'google',
      );
      expect(extractProviderFromUrl('https://GENERATIVELANGUAGE.GOOGLEAPIS.COM')).toBe('google');
    });
  });

  describe('Mistral', () => {
    it('should identify Mistral URLs', () => {
      expect(extractProviderFromUrl('https://api.mistral.ai/v1/chat/completions')).toBe('mistral');
      expect(extractProviderFromUrl('https://API.MISTRAL.AI')).toBe('mistral');
    });
  });

  describe('Cohere', () => {
    it('should identify Cohere URLs', () => {
      expect(extractProviderFromUrl('https://api.cohere.ai/v1/generate')).toBe('cohere');
      expect(extractProviderFromUrl('https://API.COHERE.AI')).toBe('cohere');
    });
  });

  describe('Perplexity', () => {
    it('should identify Perplexity URLs', () => {
      expect(extractProviderFromUrl('https://api.perplexity.ai/chat/completions')).toBe(
        'perplexity',
      );
      expect(extractProviderFromUrl('https://API.PERPLEXITY.AI')).toBe('perplexity');
    });
  });

  describe('Unknown providers', () => {
    it('should return hostname for unknown providers', () => {
      expect(extractProviderFromUrl('https://example.com/api')).toBe('example.com');
      expect(extractProviderFromUrl('https://custom-llm.io/v1/chat')).toBe('custom-llm.io');
    });
  });

  describe('Invalid URLs', () => {
    it('should return "unknown" for invalid URLs', () => {
      expect(extractProviderFromUrl('not-a-url')).toBe('unknown');
      expect(extractProviderFromUrl('')).toBe('unknown');
      expect(extractProviderFromUrl('://')).toBe('unknown');
    });
  });

  describe('Case insensitivity', () => {
    it('should handle URLs with mixed case', () => {
      expect(extractProviderFromUrl('https://API.OpenAI.COM/v1')).toBe('openai');
      expect(extractProviderFromUrl('https://Api.Anthropic.Com/v1')).toBe('anthropic');
      expect(extractProviderFromUrl('https://OpenRouter.AI/api/v1')).toBe('openrouter');
    });
  });
});
