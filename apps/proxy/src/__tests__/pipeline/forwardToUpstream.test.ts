import { describe, expect, it } from 'vitest';
import { buildUpstreamHeaders } from '../../pipeline/forwardToUpstream';

describe('buildUpstreamHeaders', () => {
  it('keeps provider credentials and request semantics', () => {
    const headers = buildUpstreamHeaders(
      new Headers({
        authorization: 'Bearer sk-test',
        'x-api-key': 'sk-ant',
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'http-referer': 'https://app.example',
      }),
    );
    expect(Object.fromEntries(headers)).toEqual({
      authorization: 'Bearer sk-test',
      'x-api-key': 'sk-ant',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'http-referer': 'https://app.example',
    });
  });

  it('strips proxy, trace context, hop-by-hop, and caller network headers', () => {
    const headers = buildUpstreamHeaders(
      new Headers({
        'x-trace-flow-api-key': 'tf_key',
        'x-trace-flow-omit-body': 'true',
        traceparent: '00-abc-def-01',
        baggage: 'a=b',
        host: 'proxy.example',
        'content-length': '10',
        'proxy-authorization': 'Basic x',
        'keep-alive': 'timeout=5',
        'cf-connecting-ip': '203.0.113.9',
        'cf-ipcountry': 'US',
        'x-forwarded-for': '203.0.113.9',
        'x-forwarded-proto': 'https',
        'x-real-ip': '203.0.113.9',
        'true-client-ip': '203.0.113.9',
        forwarded: 'for=203.0.113.9',
        'content-type': 'application/json',
      }),
    );
    expect(Object.fromEntries(headers)).toEqual({ 'content-type': 'application/json' });
  });
});
