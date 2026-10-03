import type { ImportedAccountPlan } from '@trace-flow/otel-conventions';

export interface AccountPlanPrice {
  label: string;
  /** Monthly list price for one seat; null when a list price would mislead leverage. */
  monthlyUsd: number | null;
  verifiedOn: string;
}

// Public list prices change rarely, are the same for every Organization, and are worth a code
// review when they do, so they live here instead of in a user-edited or Convex-managed table.
// Free, Team, Enterprise, and unknown plans have no meaningful per-account list price: free is $0,
// Team seats vary by seat type and billing period, and Enterprise is quoted.
const VERIFIED_ON = '2026-10-03';

export const ACCOUNT_PLAN_PRICES = {
  claude_pro: { label: 'Claude Pro', monthlyUsd: 20, verifiedOn: VERIFIED_ON },
  claude_max_5x: { label: 'Claude Max 5x', monthlyUsd: 100, verifiedOn: VERIFIED_ON },
  claude_max_20x: { label: 'Claude Max 20x', monthlyUsd: 200, verifiedOn: VERIFIED_ON },
  chatgpt_free: { label: 'ChatGPT Free', monthlyUsd: null, verifiedOn: VERIFIED_ON },
  chatgpt_plus: { label: 'ChatGPT Plus', monthlyUsd: 20, verifiedOn: VERIFIED_ON },
  chatgpt_pro: { label: 'ChatGPT Pro', monthlyUsd: 200, verifiedOn: VERIFIED_ON },
  // OpenAI renamed ChatGPT Team to ChatGPT Business in 2025; the contract value keeps the old name.
  chatgpt_team: { label: 'ChatGPT Business', monthlyUsd: null, verifiedOn: VERIFIED_ON },
  chatgpt_enterprise: { label: 'ChatGPT Enterprise', monthlyUsd: null, verifiedOn: VERIFIED_ON },
  unknown: { label: 'Unknown plan', monthlyUsd: null, verifiedOn: VERIFIED_ON },
} as const satisfies Record<ImportedAccountPlan, AccountPlanPrice>;

/** Looks up a stored plan value; anything outside the contract, including '', has no price. */
export function accountPlanPrice(plan: string): AccountPlanPrice | null {
  return Object.prototype.hasOwnProperty.call(ACCOUNT_PLAN_PRICES, plan)
    ? ACCOUNT_PLAN_PRICES[plan as ImportedAccountPlan]
    : null;
}

export function planListPrice(plan: string): number | null {
  return accountPlanPrice(plan)?.monthlyUsd ?? null;
}
