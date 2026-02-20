import { describe, it, expect } from 'vitest';
import { parseGoogleTokens } from '../../../parsers/providers/google';

describe('parseGoogleTokens', () => {
  it('should parse promptTokenCount / candidatesTokenCount / totalTokenCount', () => {
    const body = JSON.stringify({
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 5,
        totalTokenCount: 15,
      },
    });

    const result = parseGoogleTokens(body);

    expect(result).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    });
  });

  it('should map cachedContentTokenCount to cacheReadTokens', () => {
    const body = JSON.stringify({
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 50,
        cachedContentTokenCount: 80,
        totalTokenCount: 150,
      },
    });

    const result = parseGoogleTokens(body);

    expect(result).toEqual({
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      cacheReadTokens: 80,
    });
  });

  it('should handle response with only prompt tokens', () => {
    const body = JSON.stringify({
      usageMetadata: { promptTokenCount: 42 },
    });

    const result = parseGoogleTokens(body);

    expect(result?.promptTokens).toBe(42);
    expect(result?.completionTokens).toBeUndefined();
  });

  it('should return undefined when no Google token fields found', () => {
    const body = JSON.stringify({ candidates: [{ content: {} }] });
    expect(parseGoogleTokens(body)).toBeUndefined();
  });
});
