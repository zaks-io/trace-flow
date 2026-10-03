import { describe, expect, it } from 'vitest';
import { IMPORTED_ACCOUNT_PLANS } from '@trace-flow/otel-conventions';
import { ACCOUNT_PLAN_PRICES, accountPlanPrice, planListPrice } from '../plans';

describe('account plan list prices', () => {
  it.each([
    ['claude_pro', 20],
    ['claude_max_5x', 100],
    ['claude_max_20x', 200],
    ['chatgpt_plus', 20],
    ['chatgpt_pro', 200],
  ])('prices %s at $%i a month', (plan, monthlyUsd) => {
    expect(planListPrice(plan)).toBe(monthlyUsd);
  });

  it.each(['chatgpt_free', 'chatgpt_team', 'chatgpt_enterprise', 'unknown'])(
    'leaves %s without a list price',
    (plan) => {
      expect(planListPrice(plan)).toBeNull();
      expect(accountPlanPrice(plan)?.label).toBeTruthy();
    },
  );

  it.each(['', 'claude_max', 'constructor', 'toString', '__proto__'])(
    'treats %j as an unrecognized plan',
    (plan) => {
      expect(accountPlanPrice(plan)).toBeNull();
      expect(planListPrice(plan)).toBeNull();
    },
  );

  it('covers every contract plan with a user-facing label and verification date', () => {
    expect(Object.keys(ACCOUNT_PLAN_PRICES).sort()).toEqual([...IMPORTED_ACCOUNT_PLANS].sort());
    for (const price of Object.values(ACCOUNT_PLAN_PRICES)) {
      expect(price.label).not.toMatch(/_/);
      expect(price.verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('labels plans by product name', () => {
    expect(accountPlanPrice('claude_max_20x')?.label).toBe('Claude Max 20x');
    expect(accountPlanPrice('chatgpt_pro')?.label).toBe('ChatGPT Pro');
  });
});
