import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ReviewUnitCostsCell } from '../ReviewUnitCostsCell';
import type { AgentReviewUnitCostRow } from '../types';

function row(overrides: Partial<AgentReviewUnitCostRow> = {}): AgentReviewUnitCostRow {
  return {
    review_unit_key: 'hosted:github.com/acme/app:pull_request:42',
    review_url: 'https://github.com/acme/app/pull/42',
    review_host: 'github.com',
    review_owner: 'acme',
    review_repo: 'app',
    review_number: 42,
    repo_fingerprint: 'repo_abc',
    git_branch: 'feature/direct-review-cost',
    attribution_method: 'direct_link',
    confidence: 'high',
    rule_version: 'direct_link_v1',
    session_count: 3,
    message_count: 20,
    priced_message_count: 18,
    coverage_pct: 0.9,
    estimated_cost_usd: 12.345,
    last_event_ms: 1_700_000_000_000,
    ...overrides,
  };
}

describe('ReviewUnitCostsCell', () => {
  it('renders the honest empty state', () => {
    const html = renderToStaticMarkup(
      <ReviewUnitCostsCell rows={[]} labelFor={(value) => value} />,
    );

    expect(html).toContain('Review unit costs');
    expect(html).toContain('directly linked PRs and MRs');
    expect(html).toContain('No directly linked review units in this range.');
    expect(html).toContain('Direct links only.');
  });

  it('renders populated direct-link review unit costs', () => {
    const html = renderToStaticMarkup(
      <ReviewUnitCostsCell rows={[row()]} labelFor={() => 'github.com/acme/app'} />,
    );

    expect(html).toContain('github.com/acme/app PR #42');
    expect(html).toContain('https://github.com/acme/app/pull/42');
    expect(html).toContain('$12.35');
    expect(html).toContain('1 review unit, 3 sessions');
    expect(html).toContain('90%');
  });

  it('labels GitLab merge requests as MR', () => {
    const html = renderToStaticMarkup(
      <ReviewUnitCostsCell
        rows={[
          row({
            review_unit_key: 'hosted:gitlab.com/acme/app:merge_request:7',
            review_url: 'https://gitlab.com/acme/app/-/merge_requests/7',
            review_host: 'gitlab.com',
            review_number: 7,
          }),
        ]}
        labelFor={() => 'gitlab.com/acme/app'}
      />,
    );

    expect(html).toContain('gitlab.com/acme/app MR #7');
  });
});
