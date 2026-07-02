import { expect, type Locator, type Page, test } from '@playwright/test';
import { agentsStorageState, agentsStorageStateSkipReason } from './agents-e2e-config';

test.skip(!agentsStorageState, agentsStorageStateSkipReason);

test.describe('/app/agents authenticated walkthrough', () => {
  test('exercises filters, drilldowns, pagination, and tool reliability with live agent data', async ({
    page,
  }) => {
    await page.goto('/app/agents');

    await expect(page.getByRole('heading', { name: 'Agent Analytics' })).toBeVisible();
    await expect(
      page.getByText('Estimated cost, tokens, and activity from coding-agent transcripts.'),
    ).toBeVisible();
    await expect(page.getByRole('region', { name: 'Collector sources' })).toBeVisible();

    const emptyState = page.getByText(
      /No collector has synced yet|No CLI-ingested activity in this range|No agent activity for these filters/,
    );
    if (
      await emptyState
        .first()
        .isVisible()
        .catch(() => false)
    ) {
      throw new Error('Authenticated walkthrough requires production-like agent data.');
    }

    await expect(page.getByText(/lower bound(.*of turns priced)?/i).first()).toBeVisible();

    const metricSwitcher = page.getByRole('group', { name: 'Metric' });
    await metricSwitcher.getByRole('button', { name: 'Tokens' }).click();
    await expect(metricSwitcher.getByRole('button', { name: 'Tokens' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await metricSwitcher.getByRole('button', { name: 'Sessions' }).click();
    await expect(metricSwitcher.getByRole('button', { name: 'Sessions' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await page.getByRole('button', { name: 'Expand Cost over time' }).click();
    const groupBy = page.getByRole('group', { name: 'Group by' });
    await groupBy.getByRole('button', { name: 'Model' }).click();
    await expect(groupBy.getByRole('button', { name: 'Model' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(
      page.getByTestId('agent-usage-chart-model').getByRole('button').first(),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Model filter' }).click();
    await selectFirstMenuItem(page, /^(All Models|No options yet)$/);
    await expect(page.getByRole('button', { name: 'Model filter, 1 selected' })).toBeVisible();
    await clearFilters(page);

    await groupBy.getByRole('button', { name: 'Source' }).click();
    await expect(groupBy.getByRole('button', { name: 'Source' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.getByRole('button', { name: 'Source filter' }).click();
    await expect(page.getByRole('menuitem', { name: /cursor/i })).toHaveCount(0);
    await selectFirstMenuItem(page, /^All Sources$/);
    await expect(page.getByRole('button', { name: 'Source filter, 1 selected' })).toBeVisible();
    await clearFilters(page);

    await groupBy.getByRole('button', { name: 'Repo' }).click();
    await expect(groupBy.getByRole('button', { name: 'Repo' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    const repoLegendButton = firstConcreteLegendButton(page.getByTestId('agent-usage-chart-repo'));
    await expect(repoLegendButton).toBeVisible();
    await repoLegendButton.click();
    await expect(page.getByRole('button', { name: 'Repo filter, 1 selected' })).toBeVisible();
    await clearFilters(page);

    await page.getByRole('button', { name: 'Expand Where spend concentrates' }).click();
    const pagination = page.getByLabel('Agent session pagination');
    await expect(pagination).toContainText(/1-\d+ of/);
    const nextPage = pagination.getByRole('button', { name: 'Next' });
    if (await nextPage.isEnabled()) {
      await nextPage.click();
      await expect(pagination).toContainText(/11-\d+ of/);
      await pagination.getByRole('button', { name: 'Previous' }).click();
      await expect(pagination).toContainText(/1-\d+ of/);
    } else {
      await expect(nextPage).toBeDisabled();
    }

    await page.getByRole('button', { name: 'Expand Notable changes' }).click();
    await expect(page.getByRole('heading', { name: 'Tool usage movers' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Highest failure rates' })).toBeVisible();
  });
});

function firstConcreteLegendButton(chart: Locator): Locator {
  return chart
    .getByRole('button')
    .filter({ hasText: /^(?!Other$).+/ })
    .first();
}

async function clearFilters(page: Page) {
  await page.getByRole('button', { name: 'Clear filters' }).click();
}

async function selectFirstMenuItem(page: Page, skip: RegExp) {
  const items = page.getByRole('menuitem');
  await expect(items.first()).toBeVisible();
  const count = await items.count();

  for (let i = 0; i < count; i++) {
    const item = items.nth(i);
    const label = normalize(await item.textContent());
    const disabled = (await item.getAttribute('aria-disabled')) === 'true';
    if (!label || skip.test(label) || disabled) continue;

    await item.click();
    return label;
  }

  throw new Error('No selectable menu item found.');
}

function normalize(value: string | null): string {
  return value?.replace(/\s+/g, ' ').trim() ?? '';
}
