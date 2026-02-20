import { describe, it, expect } from 'vitest';
import { parseTokenUsage } from '../../../parsers/providers';

describe('parseTokenUsage dispatcher', () => {
  const anthropicBody = JSON.stringify({
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20 },
  });

  const openaiBody = JSON.stringify({
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  });

  const googleBody = JSON.stringify({
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 },
  });

  it('should route anthropic provider correctly', () => {
    const result = parseTokenUsage(anthropicBody, 'anthropic');
    // Anthropic normalizes: promptTokens = input_tokens + cache_read
    expect(result?.promptTokens).toBe(120);
    expect(result?.cacheReadTokens).toBe(20);
  });

  it('should route openai provider correctly', () => {
    const result = parseTokenUsage(openaiBody, 'openai');
    expect(result?.promptTokens).toBe(100);
  });

  it('should route google provider correctly', () => {
    const result = parseTokenUsage(googleBody, 'google');
    expect(result?.promptTokens).toBe(100);
  });

  it('should route groq provider correctly', () => {
    const result = parseTokenUsage(openaiBody, 'groq');
    expect(result?.promptTokens).toBe(100);
  });

  it('should route openrouter provider correctly', () => {
    const result = parseTokenUsage(openaiBody, 'openrouter');
    expect(result?.promptTokens).toBe(100);
  });

  it('should auto-detect Anthropic format when no provider given', () => {
    const result = parseTokenUsage(anthropicBody);
    // Auto-detect still normalizes Anthropic
    expect(result?.promptTokens).toBe(120);
    expect(result?.cacheReadTokens).toBe(20);
  });

  it('should auto-detect Google format when no provider given', () => {
    const result = parseTokenUsage(googleBody);
    expect(result?.promptTokens).toBe(100);
    expect(result?.completionTokens).toBe(50);
  });

  it('should return undefined for empty body', () => {
    expect(parseTokenUsage('', 'openai')).toBeUndefined();
    expect(parseTokenUsage('')).toBeUndefined();
  });
});
