import { describe, expect, it } from 'vitest';
import {
  canCompareCosts,
  costCoverageLabels,
  isCostIncomplete,
  isCostUnknown,
} from '../costCoverage';

const summary = {
  total_cost_usd: 0,
  cost_priced_count: 2,
  cost_partial_count: 1,
  cost_unpriced_count: 1,
  cost_proxy_count: 0,
  cost_unassessed_count: 0,
  cost_priced_tokens: 90,
  cost_coverage_ratio: 0.9,
};
const complete = { ...summary, cost_partial_count: 0, cost_unpriced_count: 0 };
const unassessed = { ...complete, cost_priced_count: 0, cost_unassessed_count: 1 };

describe('cost coverage', () => {
  it('distinguishes missing estimates from legitimate zero and existing monetary values', () => {
    expect(isCostUnknown({ ...complete, cost_priced_count: 0, cost_unpriced_count: 1 })).toBe(true);
    expect(isCostUnknown(unassessed)).toBe(true);
    expect(isCostUnknown({ ...unassessed, total_cost_usd: 0.25 })).toBe(false);
    expect(isCostUnknown(complete)).toBe(false);
    expect(isCostUnknown({ ...unassessed, cost_proxy_count: 1 })).toBe(false);
    expect(isCostUnknown({ ...complete, cost_priced_count: 0, cost_proxy_count: 1 })).toBe(false);
  });
  it('shows explicit pricing counts and token coverage in the existing labels', () => {
    expect(costCoverageLabels(summary).map(({ label, value }) => [label, value])).toEqual([
      ['Priced', '2'],
      ['Partial', '1'],
      ['Unpriced', '1'],
      ['Priced Tokens', '90'],
      ['Token Coverage', '90%'],
    ]);
    expect(costCoverageLabels(unassessed)).toContainEqual({
      label: 'Not Assessed',
      value: '1',
      color: 'var(--color-chart-6)',
    });
  });
  it('does not pretend unknown token coverage is zero or add labels to proxy-only usage', () => {
    expect(
      costCoverageLabels({ ...summary, cost_coverage_ratio: null }).some(
        ({ label }) => label === 'Token Coverage',
      ),
    ).toBe(false);
    expect(
      costCoverageLabels({
        ...complete,
        cost_priced_count: 0,
        cost_proxy_count: 4,
        cost_coverage_ratio: null,
      }),
    ).toEqual([]);
  });
  it.each(['cost_partial_count', 'cost_unpriced_count', 'cost_unassessed_count'] as const)(
    'withholds comparison when either period has %s',
    (field) => {
      const incomplete = { ...complete, [field]: 1 };
      expect(isCostIncomplete(incomplete)).toBe(true);
      expect(canCompareCosts(incomplete, complete)).toBe(false);
      expect(canCompareCosts(complete, incomplete)).toBe(false);
    },
  );
  it('compares fully assessed imports and proxy usage, including priced zero', () => {
    expect(isCostIncomplete(complete)).toBe(false);
    expect(canCompareCosts(complete, { ...complete, cost_proxy_count: 2 })).toBe(true);
  });
});
