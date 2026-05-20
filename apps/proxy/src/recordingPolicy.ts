import type { Logger } from '@trace-flow/logging';
import { checkBillingStatus } from './auth';
import { checkUsage, type UsageCheckResult } from './usage';
import type { TracingDecision } from './context';

interface RecordingPolicyEnv {
  API_KEYS: KVNamespace;
  USAGE_TRACKER: DurableObjectNamespace;
}

interface RecordingPolicyEvaluation {
  decision: TracingDecision;
  usageCheck: UsageCheckResult;
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
  const billing = await checkBillingStatus(env, orgId, logger);

  if (billing.status === 'suspended') {
    return {
      decision: { record: false, reason: 'suspended' },
      usageCheck: { status: 'error', reason: 'billing_not_active' },
    };
  }
  if (billing.status === 'canceled') {
    return {
      decision: { record: false, reason: 'canceled' },
      usageCheck: { status: 'error', reason: 'billing_not_active' },
    };
  }
  if (billing.status === 'not_found') {
    return {
      decision: { record: false, reason: 'no_subscription' },
      usageCheck: { status: 'error', reason: 'billing_not_active' },
    };
  }

  const usageCheck = await checkUsage(env, orgId, count, billing.subscription);

  if (usageCheck.status === 'allowed') {
    return {
      decision: { record: true, reason: 'ok', tier: usageCheck.tier },
      usageCheck,
    };
  }
  if (usageCheck.status === 'exceeded') {
    return {
      decision: {
        record: false,
        reason: 'exceeded',
        tier: usageCheck.tier,
        periodEnd: usageCheck.periodEnd,
      },
      usageCheck,
    };
  }

  return {
    decision: { record: false, reason: 'internal_error' },
    usageCheck,
  };
}
