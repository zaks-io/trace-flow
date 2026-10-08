import type { DurableObjectStorage } from '@cloudflare/workers-types';

const ERASURE_KEY = 'organization_erasure';
type ErasureState = 'pending' | 'erased';

export class FactBatcherErasure {
  private state: ErasureState | null = null;

  constructor(private readonly storage: DurableObjectStorage) {}

  async initialize(): Promise<void> {
    const erasure = await this.storage.get<{ state: ErasureState }>(ERASURE_KEY);
    this.state = erasure?.state ?? null;
    if (this.state !== null && !['pending', 'erased'].includes(this.state)) {
      throw new Error('Invalid organization erasure state');
    }
  }

  isErased(): boolean {
    return this.state === 'erased';
  }

  assertNotErasing(): void {
    if (this.state !== null) throw new Error('Organization erasure has started');
  }

  async begin(): Promise<void> {
    if (this.isErased()) return;
    this.state = 'pending';
    await this.storage.put(ERASURE_KEY, { state: 'pending' as const });
  }

  async erase(): Promise<{ erased: boolean }> {
    if (this.isErased()) return { erased: true };
    if (this.state !== 'pending') throw new Error('Organization erasure has not started');
    await this.storage.deleteAll();
    await this.storage.put(ERASURE_KEY, { state: 'erased' as const });
    this.state = 'erased';
    return { erased: true };
  }
}
