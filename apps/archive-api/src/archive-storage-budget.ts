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
  reserveBudgetStorage,
  snapshot,
  type StorageBudgetObject,
  type StorageBudgetReservation,
  type StorageBudgetSnapshot,
} from './archive-storage-budget-ledger';
import {
  ensureReconciliationSchema,
  reconcileBudgetInventoryPage,
  reconciliationState,
  startBudgetReconciliation,
  type ReconciliationState,
} from './archive-storage-budget-reconciliation';
import { publishArchiveStatus } from './archive-status';

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
    const result = await reserveBudgetStorage(this.ctx.storage, this.env, input);
    await this.scheduleAlarmIfNeeded();
    return result;
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
    const turn = this.reconciliationQueue.then(() => this.reconcilePage(input));
    this.reconciliationQueue = turn.then(
      () => undefined,
      () => undefined,
    );
    return turn;
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
      console.error(
        JSON.stringify({
          event: 'archive_api.status_publication_failed',
          errorClass: error instanceof Error ? error.message : 'unknown_error',
        }),
      );
      await this.ctx.storage.setAlarm(Date.now() + STATUS_RETRY_MS);
      return false;
    }
  }

  async alarm(): Promise<void> {
    await this.flushStatusOutbox();
    const reconciliation = reconciliationState(this.ctx.storage);
    if (reconciliation.activeGeneration !== undefined) {
      try {
        await this.reconcileArchiveInventory({ orgId: this.orgId(), limit: 1000 });
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
    const outbox = [
      ...this.ctx.storage.sql.exec<{ id: number }>(
        'SELECT id FROM storage_budget_status_outbox WHERE id = 1',
      ),
    ][0];
    const reconciliation = reconciliationState(this.ctx.storage);
    if (reconciliation.activeGeneration !== undefined || outbox) {
      await this.ctx.storage.setAlarm(Date.now() + STATUS_RETRY_MS);
    }
  }

  private async reconcilePage(input: {
    orgId: string;
    limit?: number;
  }): Promise<{ complete: boolean; generation: number; cursor?: string }> {
    try {
      const result = await reconcileBudgetInventoryPage(this.ctx.storage, this.env, input);
      await this.scheduleAlarmIfNeeded();
      return result;
    } catch (error) {
      await this.scheduleAlarmIfNeeded();
      throw error;
    }
  }
}
