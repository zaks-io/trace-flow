import * as Sentry from '@sentry/cloudflare';
import * as sentryTracing from '@trace-flow/utils/sentry-tracing';
import { DurableObject } from 'cloudflare:workers';
import {
  requireReconcileAction,
  requireRecoveryReason,
  TinybirdRecoveryStore,
  type ReconcileRecoveryInput,
  type RecoveryPage,
  type RecoveryPageOptions,
  type RecoveryRecord,
} from '@trace-flow/tinybird-client';
import type { AgentConsumerEnv } from './context';
import { DlqCleanup } from './dlq-cleanup';

export const AGENT_DEAD_LETTERS_INSTANCE_NAME = '__dlq__';

class AgentDeadLettersBase extends DurableObject<AgentConsumerEnv> {
  private readonly recovery: TinybirdRecoveryStore;

  constructor(state: DurableObjectState, env: AgentConsumerEnv) {
    super(state, env);
    this.recovery = new TinybirdRecoveryStore(state.storage);
    void this.ctx.blockConcurrencyWhile(() => Promise.resolve(this.recovery.initialize()));
  }

  preserveDlq(payload: string, outcome: string, dedupeKey: string): RecoveryRecord {
    return this.recovery.preserveDlq(payload, outcome, dedupeKey);
  }

  discardDlq(recoveryId: number, expectedPayloadSha256: string): Promise<void> {
    return new DlqCleanup(this.ctx.storage, this.recovery).discard(
      recoveryId,
      expectedPayloadSha256,
    );
  }

  discardOrganizationDlq(
    orgId: string,
    input: { afterId?: number; limit?: number } = {},
  ): { deleted: number; nextAfterId: number | null } {
    return new DlqCleanup(this.ctx.storage, this.recovery).discardOrganization(orgId, input);
  }

  listRecovery(options: RecoveryPageOptions = {}): RecoveryPage {
    return this.recovery.list(options);
  }

  reconcileRecovery(input: ReconcileRecoveryInput): RecoveryRecord {
    requireRecoveryReason(input.reason);
    const record = this.recovery.get(input.recoveryId);
    requireReconcileAction(record, input.action);
    return this.recovery.resolve(record.id, input.action, input.reason);
  }
}

export const AgentDeadLetters = Sentry.instrumentDurableObjectWithSentry(
  (env: AgentConsumerEnv) => ({
    dsn: env.SENTRY_DSN,
    release: env.CF_VERSION_METADATA?.id,
    environment: env.SENTRY_ENVIRONMENT ?? 'development',
    tracesSampleRate: 1.0,
    tracePropagationTargets: sentryTracing.TRACE_FLOW_PROPAGATION_TARGETS,
    ...sentryTracing.sentryRequestPrivacy(),
    // Match the caller so RPC instrumentation strips metadata before invoking business methods.
    enableRpcTracePropagation: true,
  }),
  AgentDeadLettersBase,
);

export type AgentDeadLettersInstance = InstanceType<typeof AgentDeadLetters>;
