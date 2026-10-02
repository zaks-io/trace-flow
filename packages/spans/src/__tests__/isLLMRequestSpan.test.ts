import { describe, expect, it } from 'vitest';
import { isLLMRequestSpan } from '../isLLMRequestSpan';

describe('isLLMRequestSpan', () => {
  it('returns true when trace_flow.source is proxy', () => {
    expect(
      isLLMRequestSpan({
        SpanName: 'chat openai gpt-4',
        SpanAttributes: '{"trace_flow.source":"proxy","gen_ai.system":"openai"}',
      }),
    ).toBe(true);
  });

  it('returns true for an imported execution root', () => {
    expect(
      isLLMRequestSpan({
        SpanName: 'gpt-5',
        SpanAttributes:
          '{"trace_flow.source":"imported_execution","cliproxyapi.execution.id":"execution"}',
      }),
    ).toBe(true);
  });

  it('returns false when trace_flow.source is missing', () => {
    expect(
      isLLMRequestSpan({
        SpanName: 'http GET /api/foo',
        SpanAttributes: '{"http.method":"GET"}',
      }),
    ).toBe(false);
  });

  it('returns false when trace_flow.source is a different value', () => {
    expect(
      isLLMRequestSpan({
        SpanName: 'do thing',
        SpanAttributes: '{"trace_flow.source":"agent"}',
      }),
    ).toBe(false);
  });

  it('returns false for malformed SpanAttributes', () => {
    expect(
      isLLMRequestSpan({
        SpanName: 'oops',
        SpanAttributes: 'not json',
      }),
    ).toBe(false);
  });
});
