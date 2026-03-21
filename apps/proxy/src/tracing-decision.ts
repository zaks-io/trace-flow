import type { SubscriptionTier } from '@trace-flow/types';
import type { BillingCheckResult } from './auth';
import type { UsageCheckResult } from './usage';

export interface TracingDecision {
  record: boolean;
  reason: 'ok' | 'exceeded' | 'suspended' | 'canceled' | 'no_subscription' | 'internal_error';
  tier?: SubscriptionTier;
  periodEnd?: number;
}

export function resolveTracingDecision(
  billing: BillingCheckResult,
  usage: UsageCheckResult,
): TracingDecision {
  if (billing.status === 'suspended') return { record: false, reason: 'suspended' };
  if (billing.status === 'canceled') return { record: false, reason: 'canceled' };
  if (billing.status === 'not_found') return { record: false, reason: 'no_subscription' };

  if (usage.status === 'allowed') return { record: true, reason: 'ok', tier: usage.tier };
  if (usage.status === 'exceeded')
    return { record: false, reason: 'exceeded', tier: usage.tier, periodEnd: usage.periodEnd };

  return { record: false, reason: 'internal_error' };
}
