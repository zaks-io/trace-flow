import type { Logger } from '@trace-flow/logging';
import type { SubscriptionTier } from '@trace-flow/types';
import { checkBillingStatus } from './auth';
import { cachedUsageCheck, checkUsage, type UsageCheckResult } from './usage';
import type { TracingDecision } from './context';

interface RecordingPolicyEnv {
  API_KEYS: KVNamespace;
  USAGE_TRACKER: DurableObjectNamespace;
}

export interface RecordingPolicyEvaluation {
  decision: TracingDecision;
  usageCheck: UsageCheckResult;
}

export interface PendingRecordingPolicy {
  /**
   * The tier a request records at if the usage check allows it. Set only while that check still
   * needs a Durable Object round trip, so callers can start tier-dependent work alongside it and
   * must undo that work when `evaluation` declines to record.
   */
  provisionalTier?: SubscriptionTier;
  evaluation: Promise<RecordingPolicyEvaluation>;
}

/**
 * Owns the billing + usage + decision dance the proxy and OTLP ingest both ran
 * inline. Callers ask one question — "should this request be recorded?" — and
 * read the verdict off `decision.reason` instead of sequencing three checks.
 *
 * The skip rule (suspended/canceled/no-subscription short-circuit the usage
 * call) lives here, not at the call site, so both ingest paths agree on it.
 */
export async function evaluateRecordingPolicy(
  env: RecordingPolicyEnv,
  orgId: string,
  count: number,
  logger?: Logger,
): Promise<RecordingPolicyEvaluation> {
  return (await startRecordingPolicy(env, orgId, count, logger)).evaluation;
}

/**
 * Settles billing (cached KV) and returns while the usage Durable Object call is still in flight.
 */
export async function startRecordingPolicy(
  env: RecordingPolicyEnv,
  orgId: string,
  count: number,
  logger?: Logger,
): Promise<PendingRecordingPolicy> {
  const billing = await checkBillingStatus(env, orgId, logger);

  if (billing.status === 'suspended') {
    return settled({ record: false, reason: 'suspended' });
  }
  if (billing.status === 'canceled') {
    return settled({ record: false, reason: 'canceled' });
  }
  if (billing.status === 'not_found') {
    return settled({ record: false, reason: 'no_subscription' });
  }

  const awaitingUsage = cachedUsageCheck(orgId) === undefined;
  return {
    provisionalTier: awaitingUsage ? billing.subscription?.tier : undefined,
    evaluation: checkUsage(env, orgId, count, billing.subscription).then((usageCheck) => ({
      decision: decisionFor(usageCheck),
      usageCheck,
    })),
  };
}

function settled(decision: TracingDecision): PendingRecordingPolicy {
  return {
    evaluation: Promise.resolve({
      decision,
      usageCheck: { status: 'error', reason: 'billing_not_active' },
    }),
  };
}

function decisionFor(usageCheck: UsageCheckResult): TracingDecision {
  if (usageCheck.status === 'allowed') {
    return { record: true, reason: 'ok', tier: usageCheck.tier };
  }
  if (usageCheck.status === 'exceeded') {
    return {
      record: false,
      reason: 'exceeded',
      tier: usageCheck.tier,
      periodEnd: usageCheck.periodEnd,
    };
  }
  return { record: false, reason: 'internal_error' };
}
