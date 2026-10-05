import { describe, expect, it } from 'vitest';
import { getProvider, parseRequestModel, resolveRoute } from '../../index';

const endpoints = [
  ['/typesafe/v1/systemone', 'https://api.typesafe.ai/v1/systemone'],
  ['/openrouter/v1/systemone', 'https://openrouter.ai/api/v1/systemone'],
  ['/openrouter/alpha/decisions', 'https://openrouter.ai/api/alpha/decisions'],
] as const;

describe.each(endpoints)('decision protocol %s', (path, targetUrl) => {
  const provider = resolveRoute(path)!.provider;
  const ctx = { targetUrl, operationName: 'decision' };
  const response = {
    answers: {
      model: {
        type: 'choice',
        choice: 'usage',
        probabilities: { usage: 0.8, cost: 0.2 },
        confidence: 0.8,
      },
      usage: { type: 'score', score: 2.5, input_tokens: 9000, cost: 99 },
      input_tokens: { type: 'noul', noul: 0.95 },
    },
    model: provider.id === 'typesafe' ? 'jev-1.13.0' : 'typesafe/jev-1.13',
    id: 'decision-id',
    usage: { input_tokens: 296, output_tokens: 20, cost: 0.000012432 },
  };

  it('resolves the native endpoint and reads only top-level accounting and metadata', () => {
    expect(resolveRoute(path)?.targetUrl).toBe(targetUrl);
    const body = JSON.stringify(response);
    expect(provider.parseResponseMetadata(body, ctx)).toEqual({
      model: response.model,
      id: response.id,
    });
    expect(provider.parseResponseTokenUsage(body, ctx)).toEqual({
      promptTokens: 296,
      uncachedInputTokens: 296,
      completionTokens: 20,
      totalTokens: 316,
      ...(provider.id === 'openrouter' ? { upstreamCost: response.usage.cost } : {}),
    });
  });

  it('preserves explicit zero and missing counts', () => {
    expect(
      provider.parseResponseTokenUsage(
        '{"usage":{"input_tokens":0,"output_tokens":0,"cost":0}}',
        ctx,
      ),
    ).toEqual({
      promptTokens: 0,
      uncachedInputTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      ...(provider.id === 'openrouter' ? { upstreamCost: 0 } : {}),
    });
    expect(provider.parseResponseTokenUsage('{"usage":{"input_tokens":2}}', ctx)).toEqual({
      promptTokens: 2,
      uncachedInputTokens: 2,
    });
    expect(
      provider.parseResponseTokenUsage('{"answers":{"usage":{"input_tokens":99}},"usage":{}}', ctx),
    ).toBeUndefined();
  });

  it.each([-1, 1.2, '4', null, 9007199254740992])('rejects invalid token count %j', (value) => {
    expect(
      provider.parseResponseTokenUsage(
        JSON.stringify({ usage: { input_tokens: value, output_tokens: 20 } }),
        ctx,
      ),
    ).toBeUndefined();
  });

  it.each([
    '{"usage":{"input_tokens":2,"input_tokens":3}}',
    '{"usage":{"input_tokens":2},"usage":{"input_tokens":3}}',
    '{"usage":{"input_tokens":2,"\\u0069nput_tokens":3}}',
    '{"usage":{"input_tokens":2,"output_tokens":3}',
    '{"usage":{"input_tokens":2,}}',
    '[]',
    'null',
  ])('rejects ambiguous or malformed JSON without partial regex guesses', (body) => {
    expect(provider.parseResponseTokenUsage(body, ctx)).toBeUndefined();
  });
});

describe('decision model attribution', () => {
  it('reads the requested model without looking inside state or questions', () => {
    expect(parseRequestModel('{"state":{"model":"private-answer"},"model":"jev-latest"}')).toBe(
      'jev-latest',
    );
    expect(parseRequestModel('{"model":"jev-latest","model":"other"}')).toBeUndefined();
    expect(parseRequestModel('{"state":{"model":"jev-latest"}}')).toBeUndefined();
    expect(parseRequestModel('{"model":123}')).toBeUndefined();
  });

  it.each([-1, '0', null])('rejects malformed OpenRouter cost %j', (cost) => {
    expect(
      getProvider('openrouter').parseResponseTokenUsage(
        JSON.stringify({ usage: { input_tokens: 2, cost } }),
        { targetUrl: '', operationName: 'decision' },
      ),
    ).toBeUndefined();
  });

  it('rejects nonfinite costs and overflowing totals', () => {
    const context = { targetUrl: '', operationName: 'decision' };
    expect(
      getProvider('openrouter').parseResponseTokenUsage('{"usage":{"cost":1e999}}', context),
    ).toBeUndefined();
    expect(
      getProvider('typesafe').parseResponseTokenUsage(
        '{"usage":{"input_tokens":9007199254740991,"output_tokens":1}}',
      ),
    ).toBeUndefined();
  });
});
