import { describe, it, expect } from 'vitest';
import type { QueueMessage, LLMTokenUsage } from '@trace-flow/types';
import {
  requestAttributes,
  tokenAttributes,
  costAttributes,
  upstreamCostAttribute,
  responseMetadataAttributes,
  errorAttributes,
  timingAttributes,
  ttftAttributes,
  baggageAttributes,
  inputMessageEvents,
  outputBlockEvents,
  contentBlockSpanAttributes,
  toolCallBracketEvents,
} from '../index';

function makeMessage(): QueueMessage {
  return {
    requestId: 'req-1',
    apiKey: 'key',
    targetUrl: 'https://api.openai.com/v1/chat/completions',
    request: { id: 'r', provider: 'openai', model: 'gpt-4', messages: [], timestamp: 0 },
    response: { id: 'r', provider: 'openai', status: 200, timestamp: 0, latency: 0 },
    timing: { requestStart: 0, requestSent: 0, responseReceived: 0, responseComplete: 0 },
    receivedAt: 0,
  };
}

describe('requestAttributes', () => {
  it('emits provider, model, route, operation, streaming, source', () => {
    const attrs = requestAttributes(makeMessage(), { isStreaming: true, operationName: 'chat' });
    expect(attrs).toEqual({
      'trace_flow.source': 'proxy',
      'gen_ai.request_id': 'req-1',
      'gen_ai.system': 'openai',
      'gen_ai.request.model': 'gpt-4',
      'http.url': 'https://api.openai.com/v1/chat/completions',
      'http.response.status_code': '200',
      'gen_ai.streaming': 'true',
      'gen_ai.operation.name': 'chat',
    });
  });
});

describe('tokenAttributes', () => {
  it('emits every populated field, including zero values', () => {
    const tokens: LLMTokenUsage = {
      promptTokens: 100,
      uncachedInputTokens: 75,
      completionTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 25,
    };
    const attrs = tokenAttributes(tokens);
    expect(attrs).toEqual({
      'gen_ai.usage.input_tokens': '100',
      'gen_ai.usage.input_tokens_uncached': '75',
      'gen_ai.usage.output_tokens': '0',
      'gen_ai.usage.reasoning_tokens': '0',
      'gen_ai.usage.cache_read_input_tokens': '25',
    });
  });

  it('skips undefined fields entirely', () => {
    expect(tokenAttributes({ completionTokens: 50 })).toEqual({
      'gen_ai.usage.output_tokens': '50',
    });
  });
});

describe('costAttributes', () => {
  it('emits input/output/total/baseline/impact unconditionally; cache + reasoning only when > 0', () => {
    const attrs = costAttributes({
      inputCostMicrodollars: 1000,
      outputCostMicrodollars: 2000,
      cacheReadCostMicrodollars: 500,
      cacheWriteCostMicrodollars: 0,
      reasoningCostMicrodollars: 0,
      promptBaselineCostMicrodollars: 1500,
      cacheImpactCostMicrodollars: 500,
      totalCostMicrodollars: 3500,
    });
    expect(attrs).toEqual({
      'gen_ai.cost.input': '0.001',
      'gen_ai.cost.output': '0.002',
      'gen_ai.cost.total': '0.0035',
      'gen_ai.cost.cache_read': '0.0005',
      'gen_ai.cost.prompt_baseline': '0.0015',
      'gen_ai.cost.cache_impact': '0.0005',
    });
  });
});

describe('upstreamCostAttribute', () => {
  it('normalizes dollars through the microdollar formatter', () => {
    expect(upstreamCostAttribute(0.0042)).toEqual({ 'gen_ai.cost.upstream': '0.0042' });
  });
  it('returns empty when undefined', () => {
    expect(upstreamCostAttribute(undefined)).toEqual({});
  });
});

describe('responseMetadataAttributes', () => {
  it('maps refusal/reasoning to boolean presence flags', () => {
    const attrs = responseMetadataAttributes({
      id: 'resp-1',
      model: 'gpt-4',
      finishReason: 'stop',
      refusal: null,
      reasoning: 'thinking...',
      hasLogprobs: false,
    });
    expect(attrs).toEqual({
      'gen_ai.response_id': 'resp-1',
      'gen_ai.response.model': 'gpt-4',
      'gen_ai.finish_reason': 'stop',
      'gen_ai.has_logprobs': 'false',
      'gen_ai.has_refusal': 'false',
      'gen_ai.has_reasoning': 'true',
    });
  });
});

describe('errorAttributes', () => {
  it('emits type + code only when present', () => {
    expect(errorAttributes({ type: 'invalid_request_error', code: 'context_length' })).toEqual({
      'error.type': 'invalid_request_error',
      'error.code': 'context_length',
    });
    expect(errorAttributes({})).toEqual({});
  });
});

describe('timingAttributes', () => {
  it('emits proxy_overhead + upstream_ttfb; tokens_per_second from generation duration', () => {
    const attrs = timingAttributes(
      {
        requestStart: 0,
        requestSent: 10,
        responseReceived: 50,
        firstTokenReceived: 60,
        responseComplete: 1060,
      },
      { completionTokens: 100 },
    );
    expect(attrs['trace_flow.proxy_overhead_ms']).toBe('10');
    expect(attrs['trace_flow.upstream_ttfb_ms']).toBe('40');
    expect(attrs['gen_ai.tokens_per_second']).toBe('100.00');
  });

  it('falls back to full request latency for single-chunk responses', () => {
    const attrs = timingAttributes(
      {
        requestStart: 0,
        requestSent: 100,
        responseReceived: 200,
        firstTokenReceived: 1100,
        responseComplete: 1100,
      },
      { completionTokens: 1000 },
    );
    expect(attrs['gen_ai.tokens_per_second']).toBe('1000.00');
  });

  it('skips tokens_per_second when no completion tokens', () => {
    const attrs = timingAttributes({
      requestStart: 0,
      requestSent: 10,
      responseReceived: 50,
      responseComplete: 100,
    });
    expect(attrs['gen_ai.tokens_per_second']).toBeUndefined();
  });
});

describe('ttftAttributes', () => {
  it('emits server TTFT', () => {
    expect(ttftAttributes(150)).toEqual({ 'gen_ai.server.time_to_first_token': '150' });
  });
});

describe('baggageAttributes', () => {
  it('prefixes each entry with baggage.', () => {
    expect(baggageAttributes({ feature: 'beta', userId: 'u1' })).toEqual({
      'baggage.feature': 'beta',
      'baggage.userId': 'u1',
    });
  });
});

describe('inputMessageEvents', () => {
  it('emits a single event for system messages', () => {
    const events = inputMessageEvents(
      [{ role: 'system', index: 0, contentBlocks: [{ index: 0, type: 'text' }] }],
      1000,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.name).toBe('input.system');
  });

  it('emits one event per content block for user/assistant messages', () => {
    const events = inputMessageEvents(
      [
        {
          role: 'user',
          index: 0,
          contentBlocks: [
            { index: 0, type: 'text' },
            { index: 1, type: 'tool_use', toolUseId: 't1', toolName: 'search' },
          ],
        },
      ],
      1000,
    );
    expect(events.map((e) => e.name)).toEqual(['input.text', 'input.tool_use']);
    expect(events[1]?.attributes['gen_ai.tool.id']).toBe('t1');
    expect(events[1]?.attributes['gen_ai.tool.name']).toBe('search');
  });
});

describe('outputBlockEvents', () => {
  it('uses block stopTimestamp when available, falls back otherwise', () => {
    const events = outputBlockEvents(
      [
        { index: 0, type: 'text', startTimestamp: 100, stopTimestamp: 200 },
        { index: 1, type: 'tool_use', startTimestamp: 300, toolUseId: 't1', toolName: 'go' },
      ],
      999,
    );
    expect(events[0]?.timestampMs).toBe(200);
    expect(events[1]?.timestampMs).toBe(999);
    expect(events[1]?.attributes['gen_ai.tool.id']).toBe('t1');
  });
});

describe('contentBlockSpanAttributes', () => {
  it('computes unified message index inputMessageCount + messageIndex*100 + blockIndex', () => {
    const attrs = contentBlockSpanAttributes(
      { index: 3, type: 'text', startTimestamp: 0 },
      2,
      'req-1',
      5,
    );
    // 5 + 2*100 + 3 = 208
    expect(attrs['gen_ai.message.index']).toBe('208');
  });
});

describe('toolCallBracketEvents', () => {
  it('emits start + end for tool_use with stopTimestamp', () => {
    const events = toolCallBracketEvents({
      index: 0,
      type: 'tool_use',
      startTimestamp: 100,
      stopTimestamp: 200,
      toolUseId: 't1',
      toolName: 'go',
    });
    expect(events.map((e) => e.name)).toEqual(['tool_call.start', 'tool_call.end']);
  });

  it('emits nothing for non-tool_use blocks', () => {
    expect(
      toolCallBracketEvents({ index: 0, type: 'text', startTimestamp: 0, stopTimestamp: 1 }),
    ).toEqual([]);
  });
});
