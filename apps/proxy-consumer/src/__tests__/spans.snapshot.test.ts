import { describe, it, expect } from 'vitest';
import { buildSpans } from '../spans';
import type { QueueMessage, TinybirdTrace } from '@trace-flow/types';

/**
 * Snapshot test for `buildSpans` — protects against silent attribute drops
 * during the otel-conventions migration and any future refactor of the per-
 * concern helpers. Generated SpanId values are normalized to "<generated>" so
 * the snapshot stays stable across runs.
 */

const fixtureMessage: QueueMessage = {
  requestId: 'req-snapshot',
  apiKey: 'tf-snapshot',
  targetUrl: 'https://api.openai.com/v1/chat/completions',
  request: {
    id: 'req-snapshot',
    provider: 'openai',
    model: 'gpt-4',
    messages: [],
    timestamp: 1000,
  },
  response: {
    id: 'req-snapshot',
    provider: 'openai',
    status: 200,
    timestamp: 1500,
    latency: 500,
  },
  timing: {
    requestStart: 1000,
    requestSent: 1100,
    responseReceived: 1150,
    firstTokenReceived: 1200,
    responseComplete: 1500,
  },
  tokens: {
    promptTokens: 100,
    uncachedInputTokens: 75,
    completionTokens: 50,
    totalTokens: 150,
    cacheReadTokens: 25,
  },
  responseMetadata: {
    id: 'chatcmpl-1',
    model: 'gpt-4-0613',
    finishReason: 'stop',
  },
  baggage: { feature: 'beta' },
  receivedAt: 1_700_000_000_000_000_000,
  tier: 'hobby',
};

function normalize(traces: TinybirdTrace[]): TinybirdTrace[] {
  return traces.map((t) => ({
    ...t,
    SpanId: '<generated>',
    ParentSpanId: t.ParentSpanId ? '<generated>' : '',
  }));
}

describe('buildSpans snapshot', () => {
  it('matches the canonical TinybirdTrace[] shape for a representative non-streaming request', () => {
    const traces = buildSpans(fixtureMessage);
    expect(normalize(traces)).toMatchSnapshot();
  });
});
