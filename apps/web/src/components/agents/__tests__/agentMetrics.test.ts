import { describe, expect, it } from 'vitest';
import {
  AGENT_METRICS,
  AGENT_METRIC_CONFIG,
  AGENT_METRIC_KEYS,
  AGENT_METRIC_VALUE_KIND,
  type AgentMetric,
} from '../types';

describe('agent hero-chart metric/stack behavior', () => {
  it('defaults the switcher to the estimated cost metric', () => {
    expect(AGENT_METRICS[0]).toBe('cost');
  });

  it('stacks cost as a single estimated series (no per-component cost in the data model)', () => {
    expect(AGENT_METRIC_KEYS.cost).toEqual(['cost_usd']);
    expect(AGENT_METRIC_VALUE_KIND.cost).toBe('currency');
  });

  it('stacks tokens by the five token components', () => {
    expect(AGENT_METRIC_KEYS.tokens).toEqual([
      'input_tokens',
      'output_tokens',
      'cache_read_tokens',
      'cache_creation_tokens',
      'reasoning_tokens',
    ]);
    expect(AGENT_METRIC_VALUE_KIND.tokens).toBe('count');
  });

  it('stacks tool-events by outcome', () => {
    expect(AGENT_METRIC_KEYS['tool-events']).toEqual([
      'tool_success_count',
      'tool_failure_count',
      'tool_unknown_count',
    ]);
  });

  it('renders messages and sessions as single series', () => {
    expect(AGENT_METRIC_KEYS.messages).toEqual(['message_count']);
    expect(AGENT_METRIC_KEYS.sessions).toEqual(['session_count']);
  });

  it('gives every stacked key a color config so var(--color-<key>) resolves', () => {
    for (const metric of AGENT_METRICS) {
      const config = AGENT_METRIC_CONFIG[metric];
      for (const key of AGENT_METRIC_KEYS[metric]) {
        expect(config[key], `${metric} key ${key} missing config`).toBeDefined();
        expect(config[key]).toHaveProperty('color');
      }
    }
  });

  it('treats only cost as currency', () => {
    const currencyMetrics = AGENT_METRICS.filter(
      (m: AgentMetric) => AGENT_METRIC_VALUE_KIND[m] === 'currency',
    );
    expect(currencyMetrics).toEqual(['cost']);
  });
});
