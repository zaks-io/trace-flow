import { describe, expect, it } from 'vitest';
import { costCoverageLabels, isCostUnknown } from '../costCoverage';
const summary = {
  request_count: 4,
  cost_priced_count: 2,
  cost_partial_count: 1,
  cost_unpriced_count: 1,
  cost_priced_tokens: 90,
  cost_coverage_ratio: 0.9,
};
describe('cost coverage', () => {
  it('distinguishes unpriced from legitimate priced zero and mixed proxy totals', () => {
    expect(
      isCostUnknown({ ...summary, request_count: 1, cost_priced_count: 0, cost_partial_count: 0 }),
    ).toBe(true);
    expect(isCostUnknown({ ...summary, cost_unpriced_count: 0 })).toBe(false);
    expect(isCostUnknown({ ...summary, cost_priced_count: 0, cost_partial_count: 0 })).toBe(false);
  });
  it('shows explicit pricing counts and token coverage in the existing labels', () => {
    const labels = costCoverageLabels(summary);
    expect(labels.map(({ label, value }) => [label, value])).toEqual([
      ['Priced', '2'],
      ['Partial', '1'],
      ['Unpriced', '1'],
      ['Priced Tokens', '90'],
      ['Token Coverage', '90%'],
    ]);
  });
  it('does not pretend unknown coverage is zero or add labels to proxy-only usage', () => {
    expect(
      costCoverageLabels({ ...summary, cost_coverage_ratio: null }).some(
        ({ label }) => label === 'Token Coverage',
      ),
    ).toBe(false);
    expect(
      costCoverageLabels({
        ...summary,
        cost_priced_count: 0,
        cost_partial_count: 0,
        cost_unpriced_count: 0,
        cost_coverage_ratio: null,
      }),
    ).toEqual([]);
  });
});
