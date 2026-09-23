import * as Sentry from '@sentry/cloudflare';
import { TRACE_FLOW_PROPAGATION_TARGETS } from '@trace-flow/utils/sentry-tracing';
import { DurableObject } from 'cloudflare:workers';
import type { AgentConsumerEnv } from './context';

interface SnapshotKey {
  orgId: string;
  generation: number;
}
type Slot = SnapshotKey & { slot: number };

const MAX_SNAPSHOTS = 2;
export const SNAPSHOT_CAPACITY_NAME = 'global';

function validateKey(input: SnapshotKey): SnapshotKey {
  if (
    !input ||
    typeof input !== 'object' ||
    Object.keys(input).sort().join(',') !== 'generation,orgId' ||
    typeof input.orgId !== 'string' ||
    input.orgId.length === 0 ||
    input.orgId.length > 256 ||
    input.orgId.includes(':') ||
    input.orgId.trim() !== input.orgId ||
    [...input.orgId].some((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 0x1f || codePoint === 0x7f;
    }) ||
    !Number.isSafeInteger(input.generation) ||
    input.generation <= 0
  ) {
    throw new Error('Invalid snapshot capacity key');
  }
  return input;
}

class SnapshotCapacityBase extends DurableObject<AgentConsumerEnv> {
  constructor(state: DurableObjectState, env: AgentConsumerEnv) {
    super(state, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS snapshot_capacity_slots (
        slot INTEGER PRIMARY KEY CHECK (slot BETWEEN 1 AND 2),
        org_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        UNIQUE (org_id, generation)
      )
    `);
  }

  async acquire(input: SnapshotKey): Promise<boolean> {
    const key = validateKey(input);
    return this.ctx.blockConcurrencyWhile(async () => {
      // The coordinator owns snapshot lifetime. Check it before reserving a global slot.
      if (!(await this.isActive(key))) return false;
      await this.reapTerminalSlots();
      const slots = this.readSlots();
      if (slots.some((slot) => slot.orgId === key.orgId && slot.generation === key.generation)) {
        return true;
      }
      const freeSlot = Array.from({ length: MAX_SNAPSHOTS }, (_, index) => index + 1).find(
        (slot) => !slots.some((resident) => resident.slot === slot),
      );
      if (freeSlot === undefined) return false;
      this.ctx.storage.sql.exec(
        'INSERT INTO snapshot_capacity_slots (slot, org_id, generation) VALUES (?, ?, ?)',
        freeSlot,
        key.orgId,
        key.generation,
      );
      return true;
    });
  }

  async release(input: SnapshotKey): Promise<void> {
    const key = validateKey(input);
    await this.ctx.blockConcurrencyWhile(async () => {
      const slot = this.readSlots().find(
        (resident) => resident.orgId === key.orgId && resident.generation === key.generation,
      );
      if (!slot || !(await this.isTerminal(key))) return;
      this.ctx.storage.sql.exec(
        'DELETE FROM snapshot_capacity_slots WHERE slot = ? AND org_id = ? AND generation = ?',
        slot.slot,
        key.orgId,
        key.generation,
      );
    });
  }

  private readSlots(): Slot[] {
    return this.ctx.storage.sql
      .exec<{ slot: number; org_id: string; generation: number }>(
        'SELECT slot, org_id, generation FROM snapshot_capacity_slots ORDER BY slot',
      )
      .toArray()
      .map((row) => ({ slot: row.slot, orgId: row.org_id, generation: row.generation }));
  }

  private coordinator(orgId: string) {
    return this.env.AGENT_DELIVERY_COORDINATOR.getByName(`org:${orgId}`);
  }

  private async isActive(key: SnapshotKey): Promise<boolean> {
    const stats = await this.coordinator(key.orgId).getStats({});
    return (
      !stats.erasureStarted &&
      stats.gatePhase === 'snapshot' &&
      stats.activeSnapshotGeneration === key.generation
    );
  }

  private async isTerminal(key: SnapshotKey): Promise<boolean> {
    const coordinator = this.coordinator(key.orgId);
    const stats = await coordinator.getStats({});
    if (
      stats.activeSnapshotGeneration === key.generation ||
      stats.lastSnapshotGeneration < key.generation
    ) {
      return false;
    }
    const intents = await coordinator.getOutstandingSnapshotCopyIntents({});
    return !intents.some((intent) => intent.generation === key.generation);
  }

  private async reapTerminalSlots(): Promise<void> {
    for (const slot of this.readSlots()) {
      if (await this.isTerminal(slot)) {
        this.ctx.storage.sql.exec(
          'DELETE FROM snapshot_capacity_slots WHERE slot = ? AND org_id = ? AND generation = ?',
          slot.slot,
          slot.orgId,
          slot.generation,
        );
      }
    }
  }
}

export const SnapshotCapacity = Sentry.instrumentDurableObjectWithSentry(
  (env: AgentConsumerEnv) => ({
    dsn: env.SENTRY_DSN,
    release: env.CF_VERSION_METADATA?.id,
    environment: env.SENTRY_ENVIRONMENT ?? 'development',
    tracesSampleRate: 1.0,
    tracePropagationTargets: TRACE_FLOW_PROPAGATION_TARGETS,
    enableRpcTracePropagation: true,
  }),
  SnapshotCapacityBase,
);

export type SnapshotCapacityInstance = InstanceType<typeof SnapshotCapacity>;
