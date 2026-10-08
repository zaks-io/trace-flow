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
import { FactBatcherErasure } from './fact-batcher-erasure';

class AgentFactBatcherBase extends DurableObject<AgentConsumerEnv> {
  private readonly erasure: FactBatcherErasure;
  private readonly recovery: TinybirdRecoveryStore;

  constructor(state: DurableObjectState, env: AgentConsumerEnv) {
    super(state, env);
    this.erasure = new FactBatcherErasure(state.storage);
    this.recovery = new TinybirdRecoveryStore(state.storage);
    void this.ctx.blockConcurrencyWhile(async () => {
      await this.erasure.initialize();
      if (this.erasure.isErased()) return;
      this.recovery.initialize();
    });
  }

  async alarm(): Promise<void> {
    // Completing this handler clears flush alarms left by older versions.
  }

  preserveDlq(payload: string, outcome: string, dedupeKey: string): RecoveryRecord {
    this.erasure.assertNotErasing();
    return this.recovery.preserveDlq(payload, outcome, dedupeKey);
  }

  async discardDlq(recoveryId: number, expectedPayloadSha256: string): Promise<void> {
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

  async eraseOrganizationData(): Promise<{ erased: boolean }> {
    await this.erasure.begin();
    await this.ctx.storage.deleteAlarm();
    return this.erasure.erase();
  }

  listRecovery(options: RecoveryPageOptions = {}): RecoveryPage {
    this.erasure.assertNotErasing();
    return this.recovery.list(options);
  }

  reconcileRecovery(input: ReconcileRecoveryInput): RecoveryRecord {
    this.erasure.assertNotErasing();
    requireRecoveryReason(input.reason);
    const record = this.recovery.get(input.recoveryId);
    requireReconcileAction(record, input.action);
    if (record.kind === 'tinybird_insert') {
      throw new Error(
        'Cannot reconcile tinybird_insert recovery: the retired fact ledger no longer flushes',
      );
    }
    return this.recovery.resolve(record.id, input.action, input.reason);
  }
}

export const AgentFactBatcher = Sentry.instrumentDurableObjectWithSentry(
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
  AgentFactBatcherBase,
);

export type AgentFactBatcherInstance = InstanceType<typeof AgentFactBatcher>;
