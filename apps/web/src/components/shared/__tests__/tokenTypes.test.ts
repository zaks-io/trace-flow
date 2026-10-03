import { describe, expect, it } from 'vitest';
import { AGENT_METRIC_CONFIG, AGENT_METRIC_KEYS } from '@/components/agents/types';
import { COST_SERIES, costChartConfig, pieChartConfig } from '@/components/usage/types';
import { TOKEN_TYPES, TOKEN_TYPE_SERIES, buildTokenSegments, tokenTypeDash } from '../tokenTypes';

const values = { input: 5, cacheRead: 0, cacheWrite: 2, output: 3, reasoning: 1 };

describe('token type series', () => {
  it('drops empty token types and keeps the shared stack order', () => {
    expect(buildTokenSegments(values).map((seg) => seg.key)).toEqual([
      'input',
      'cacheWrite',
      'output',
      'reasoning',
    ]);
  });

  it('gives each token type one color and one dash', () => {
    const colors = TOKEN_TYPES.map((type) => TOKEN_TYPE_SERIES[type].color);
    const dashes = TOKEN_TYPES.map(tokenTypeDash);
    expect(new Set(colors).size).toBe(TOKEN_TYPES.length);
    expect(new Set(dashes).size).toBe(TOKEN_TYPES.length);
  });

  it('colors usage cost series, the cost pie and agent token series the same way', () => {
    expect(COST_SERIES.map((series) => series.type)).toEqual([...TOKEN_TYPES]);
    for (const { dataKey, type } of COST_SERIES) {
      expect(costChartConfig[dataKey]).toEqual(TOKEN_TYPE_SERIES[type]);
    }
    for (const type of TOKEN_TYPES) {
      expect(pieChartConfig[type]).toEqual(TOKEN_TYPE_SERIES[type]);
    }
    const agentTokens = AGENT_METRIC_KEYS.tokens.map((key) => AGENT_METRIC_CONFIG.tokens[key]);
    expect(agentTokens).toEqual(TOKEN_TYPES.map((type) => TOKEN_TYPE_SERIES[type]));
  });
});
