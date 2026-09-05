import { DurableObject } from 'cloudflare:workers';
import type { ArchiveApiEnv } from './context';
import { ArchiveContractError } from './archive-contract';
import {
  acknowledgeBudgetStorage,
  budgetState,
  commitBudgetStorage,
  ensureBudgetSchema,
  parseStoredStatusPayload,
  releaseBudgetStorage,
  rebaseStatusAfterConflict,
  reserveBudgetStorage,
  snapshot,
  storageAdmissionUnsafe,
  type StorageBudgetObject,
  type StorageBudgetReservation,
  type StorageBudgetSnapshot,
} from './archive-storage-budget-ledger';
import {
  ensureReconciliationSchema,
  RECONCILIATION_INTERVAL_MS,
  reconcileBudgetInventoryPage,
  reconciliationState,
  startBudgetReconciliation,
  type ReconciliationState,
} from './archive-storage-budget-reconciliation';
import { isArchiveStatusRevisionConflict, publishArchiveStatus } from './archive-status';

export {
  ARCHIVE_STORAGE_CAP_BYTES,
  type StorageBudgetObject,
  type StorageBudgetObjectClass,
  type StorageBudgetReservation,
  type StorageBudgetSnapshot,
} from './archive-storage-budget-ledger';

const STATUS_RETRY_MS = 5000;

export class StorageBudget extends DurableObject<ArchiveApiEnv> {
  private reconciliationQueue: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: ArchiveApiEnv) {
    super(ctx, env);
    void this.ctx.blockConcurrencyWhile(() => {
      ensureBudgetSchema(this.ctx.storage);
      ensureReconciliationSchema(this.ctx.storage);
      return Promise.resolve();
    });
  }

  async reserveStorage(input: {
    orgId: string;
    objects: StorageBudgetObject[];
  }): Promise<StorageBudgetReservation> {
    try {
      const result = await reserveBudgetStorage(this.ctx.storage, this.env, input);
      await this.scheduleAlarmIfNeeded();
      return result;
    } catch (error) {
      const initialized = [
        ...this.ctx.storage.sql.exec<{ id: number }>(
          'SELECT id FROM storage_budget_state WHERE id = 1',
        ),
      ][0];
      if (initialized) await this.scheduleAlarmIfNeeded();
      throw error;
    }
  }

  async commitStorage(input: {
    orgId: string;
    objects: StorageBudgetObject[];
  }): Promise<StorageBudgetSnapshot> {
    const result = commitBudgetStorage(this.ctx.storage, input);
    await this.scheduleAlarmIfNeeded();
    return result;
  }

  async releaseStorage(input: {
    orgId: string;
    objects: StorageBudgetObject[];
  }): Promise<StorageBudgetSnapshot> {
    const result = releaseBudgetStorage(this.ctx.storage, input);
    await this.scheduleAlarmIfNeeded();
    return result;
  }

  async recordArchiveAcknowledgement(input: {
    orgId: string;
    acknowledgedAt: number;
  }): Promise<StorageBudgetSnapshot> {
    const result = acknowledgeBudgetStorage(this.ctx.storage, input);
    await this.scheduleAlarmIfNeeded();
    return result;
  }

  getStorageBudget(input: { orgId: string }): StorageBudgetSnapshot {
    return snapshot(this.ctx.storage, budgetState(this.ctx.storage, input.orgId));
  }

  async startReconciliation(input: { orgId: string }): Promise<ReconciliationState> {
    const result = startBudgetReconciliation(this.ctx.storage, input.orgId);
    await this.scheduleAlarmIfNeeded();
    return result;
  }

  async reconcileArchiveInventory(input: {
    orgId: string;
    limit?: number;
  }): Promise<{ complete: boolean; generation: number; cursor?: string }> {
    return this.queueReconciliationPage(input, true);
  }

  async flushStatusOutbox(): Promise<boolean> {
    const row = [
      ...this.ctx.storage.sql.exec<{ revision: number; payload: string }>(
        'SELECT revision, payload FROM storage_budget_status_outbox WHERE id = 1',
      ),
    ][0];
    if (!row) return true;
    let update;
    try {
      update = parseStoredStatusPayload(row.payload);
    } catch (error) {
      if (error instanceof ArchiveContractError) throw error;
      throw new ArchiveContractError('storage_budget_status_corrupt');
    }
    try {
      await publishArchiveStatus(this.env, update);
      this.ctx.storage.sql.exec(
        'DELETE FROM storage_budget_status_outbox WHERE id = 1 AND revision = ?',
        row.revision,
      );
      return true;
    } catch (error) {
      await this.ctx.storage.setAlarm(Date.now() + STATUS_RETRY_MS);
      if (isArchiveStatusRevisionConflict(error)) {
        rebaseStatusAfterConflict(this.ctx.storage, this.orgId(), row.revision);
      }
      console.error(
        JSON.stringify({
          event: 'archive_api.status_publication_failed',
          errorClass: error instanceof Error ? error.message : 'unknown_error',
        }),
      );
      return false;
    }
  }

  async alarm(): Promise<void> {
    await this.flushStatusOutbox();
    const now = Date.now();
    let reconciliation = reconciliationState(this.ctx.storage);
    if (
      reconciliation.activeGeneration === undefined &&
      (storageAdmissionUnsafe(this.ctx.storage) ||
        reconciliation.lastCompletedAt === undefined ||
        now >= reconciliation.lastCompletedAt + RECONCILIATION_INTERVAL_MS)
    ) {
      startBudgetReconciliation(this.ctx.storage, this.orgId(), false);
      reconciliation = reconciliationState(this.ctx.storage);
    }
    if (reconciliation.activeGeneration !== undefined) {
      try {
        await this.queueReconciliationPage({ orgId: this.orgId(), limit: 1000 }, false);
      } catch (error) {
        console.error(
          JSON.stringify({
            event: 'archive_api.reconciliation_failed',
            errorClass: error instanceof Error ? error.message : 'unknown_error',
          }),
        );
        await this.ctx.storage.setAlarm(Date.now() + STATUS_RETRY_MS);
      }
    }
    await this.scheduleAlarmIfNeeded();
  }

  private orgId(): string {
    const row = [
      ...this.ctx.storage.sql.exec<{ org_id: string }>(
        'SELECT org_id FROM storage_budget_state WHERE id = 1',
      ),
    ][0];
    if (!row) throw new ArchiveContractError('storage_budget_uninitialized');
    return row.org_id;
  }

  private async scheduleAlarmIfNeeded(): Promise<void> {
    startBudgetReconciliation(this.ctx.storage, this.orgId(), false);
    const outbox = [
      ...this.ctx.storage.sql.exec<{ id: number }>(
        'SELECT id FROM storage_budget_status_outbox WHERE id = 1',
      ),
    ][0];
    const reconciliation = reconciliationState(this.ctx.storage);
    const now = Date.now();
    const scheduledAt =
      reconciliation.activeGeneration !== undefined || outbox
        ? now + STATUS_RETRY_MS
        : reconciliation.lastCompletedAt === undefined
          ? now + STATUS_RETRY_MS
          : reconciliation.lastCompletedAt + RECONCILIATION_INTERVAL_MS;
    const existingAlarm = await this.ctx.storage.getAlarm();
    if (existingAlarm === null || scheduledAt < existingAlarm) {
      await this.ctx.storage.setAlarm(scheduledAt);
    }
  }

  private queueReconciliationPage(
    input: { orgId: string; limit?: number },
    forceStart: boolean,
  ): Promise<{ complete: boolean; generation: number; cursor?: string }> {
    const turn = this.reconciliationQueue.then(() => this.reconcilePage(input, forceStart));
    this.reconciliationQueue = turn.then(
      () => undefined,
      () => undefined,
    );
    return turn;
  }

  private async reconcilePage(
    input: {
      orgId: string;
      limit?: number;
    },
    forceStart: boolean,
  ): Promise<{ complete: boolean; generation: number; cursor?: string }> {
    try {
      const result = await reconcileBudgetInventoryPage(this.ctx.storage, this.env, {
        ...input,
        forceStart,
      });
      await this.scheduleAlarmIfNeeded();
      return result;
    } catch (error) {
      await this.scheduleAlarmIfNeeded();
      throw error;
    }
  }
}
