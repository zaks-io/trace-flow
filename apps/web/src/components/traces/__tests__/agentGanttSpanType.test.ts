import { describe, expect, it } from 'vitest';
import { GEN_AI } from '@trace-flow/otel-conventions';
import { getSpanType, type TraceSpan } from '../agentGanttChartModel';

const span = (name: string) => ({ SpanName: name }) as TraceSpan;

describe('getSpanType', () => {
  it('classifies proxy token-count calls as LLM spans', () => {
    expect(
      getSpanType(span('count_tokens claude-sonnet'), { [GEN_AI.OPERATION_NAME]: 'count_tokens' }),
    ).toBe('llm');
  });

  it('classifies chat spans as LLM spans', () => {
    expect(getSpanType(span('chat gpt-4o'), { [GEN_AI.OPERATION_NAME]: 'chat' })).toBe('llm');
  });
});
