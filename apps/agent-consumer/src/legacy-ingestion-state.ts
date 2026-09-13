import type { DurableObjectStorage } from '@cloudflare/workers-types';
import type { LegacyRetirementRecord } from './legacy-retirement';

const MIGRATION_ID = 'bounded-agent-ingestion-v1';
const MIGRATION_KEY = 'ingestion_migration';
const ERASURE_KEY = 'organization_erasure';

type ErasureState = 'pending' | 'erased';

export class LegacyIngestionState {
  private migrationId: string | null = null;
  private erasure: ErasureState | null = null;
  private retirement: LegacyRetirementRecord | null = null;

  constructor(private readonly storage: DurableObjectStorage) {}

  async initialize(retirement: LegacyRetirementRecord | null = null): Promise<void> {
    const [migrationId, erasure] = await Promise.all([
      this.storage.get<string>(MIGRATION_KEY),
      this.storage.get<{ state: ErasureState }>(ERASURE_KEY),
    ]);
    this.migrationId = migrationId ?? null;
    this.erasure = erasure?.state ?? null;
    this.retirement = retirement;
    if (this.erasure !== null && !['pending', 'erased'].includes(this.erasure)) {
      throw new Error('Invalid organization erasure state');
    }
  }

  isFrozen(): boolean {
    return this.migrationId !== null;
  }

  isErased(): boolean {
    return this.erasure === 'erased';
  }

  isRetired(): boolean {
    return this.retirement !== null;
  }

  isFenced(): boolean {
    return this.isFrozen() || this.erasure !== null || this.retirement !== null;
  }

  assertNotErasing(): void {
    if (this.retirement !== null) throw new Error('Legacy ingestion was retired');
    if (this.erasure !== null) throw new Error('Organization erasure has started');
  }

  assertWritable(): void {
    if (this.retirement !== null) throw new Error('Legacy ingestion was retired');
    if (this.erasure !== null) throw new Error('Organization erasure has started');
    if (this.migrationId !== null) throw new Error('Legacy ingestion is frozen for migration');
  }

  assertFrozen(): void {
    if (this.retirement !== null) throw new Error('Legacy ingestion was retired');
    if (this.erasure !== null) throw new Error('Organization erasure has started');
    if (this.migrationId !== MIGRATION_ID) throw new Error('Legacy ingestion is not frozen');
  }

  async freeze(input: {
    migrationId: string;
    flushInProgress: boolean;
    pendingRows: number;
  }): Promise<{ migrationId: string }> {
    if (this.retirement !== null) throw new Error('Legacy ingestion was retired');
    if (this.erasure !== null) throw new Error('Organization erasure has started');
    if (input.migrationId !== MIGRATION_ID) throw new Error('Invalid ingestion migration');
    if (this.migrationId && this.migrationId !== input.migrationId) {
      throw new Error('Legacy migration conflict');
    }
    if (input.flushInProgress || input.pendingRows !== 0) {
      throw new Error('Legacy ingestion has not drained');
    }
    this.migrationId = input.migrationId;
    await this.storage.put(MIGRATION_KEY, input.migrationId);
    return { migrationId: input.migrationId };
  }

  async beginErasure(): Promise<{ state: 'pending' | 'erased' }> {
    if (this.erasure === 'erased') return { state: 'erased' };
    this.erasure = 'pending';
    await this.storage.put(ERASURE_KEY, { state: 'pending' as const });
    return { state: 'pending' };
  }

  applyRetirement(record: LegacyRetirementRecord): void {
    this.retirement = record;
    this.migrationId = null;
  }

  async erase(flushInProgress: boolean): Promise<{ erased: boolean }> {
    if (this.erasure === null) throw new Error('Organization erasure has not started');
    if (this.erasure === 'erased') return { erased: true };
    if (flushInProgress) return { erased: false };
    await this.storage.deleteAll();
    await this.storage.put(ERASURE_KEY, { state: 'erased' as const });
    this.migrationId = null;
    this.erasure = 'erased';
    return { erased: true };
  }

  getState(): {
    migrationId: string | null;
    erasureState: ErasureState | null;
    retirement: LegacyRetirementRecord | null;
  } {
    return {
      migrationId: this.migrationId,
      erasureState: this.erasure,
      retirement: this.retirement,
    };
  }
}
