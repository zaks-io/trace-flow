import { readCoordinatorState } from './agent-delivery-coordinator-storage';
import { assertExactKeys } from './agent-delivery-coordinator-validation';
import { failAgentSnapshot } from './agent-delivery-snapshots';
import {
  agentIngestionErasureStarted,
  listSnapshotCopyIntents,
  rejectSnapshotCopyIntent,
  type AgentSnapshotCopyIntent,
} from './agent-ingestion-erasure';
import { clearSnapshotCheck, readSnapshotCheck } from './snapshot-checks';
import { readSnapshotFailure, recordSnapshotFailure } from './snapshot-failure';

export interface ResumeSnapshotInput {
  orgId: string;
  generation: number;
  reason: string;
  abandonUnstartedCopy?: Pick<AgentSnapshotCopyIntent, 'target' | 'copyAttempt' | 'startedAt'>;
}

export function abandonUnstartedSnapshotCopy(
  storage: DurableObjectStorage,
  input: ResumeSnapshotInput,
  now: number,
): void {
  const expected = input.abandonUnstartedCopy;
  assertExactKeys(expected, ['target', 'copyAttempt', 'startedAt'], 'unstarted snapshot Copy');
  storage.transactionSync(() => {
    const state = readCoordinatorState(storage);
    const check = readSnapshotCheck(storage);
    const intents = listSnapshotCopyIntents(storage);
    const intent = intents[0];
    if (
      agentIngestionErasureStarted(storage) ||
      readSnapshotFailure(storage) ||
      state.gate_phase !== 'snapshot' ||
      state.active_snapshot_generation !== input.generation ||
      state.gate_expires_at_ms === null ||
      state.gate_expires_at_ms > now ||
      check?.generation !== input.generation ||
      check.blockedReason !== 'Snapshot Copy receipt could not be recovered' ||
      intents.length !== 1 ||
      !intent ||
      intent.jobId !== undefined ||
      intent.generation !== input.generation ||
      intent.target !== expected.target ||
      intent.copyAttempt !== expected.copyAttempt ||
      intent.startedAt !== expected.startedAt
    ) {
      throw new Error('Snapshot does not match the blocked unstarted Copy');
    }
    // The operator proves non-submission. Retiring the generation prevents any late job from publication.
    rejectSnapshotCopyIntent(storage, {
      generation: intent.generation,
      target: intent.target,
      copyAttempt: intent.copyAttempt,
    });
    failAgentSnapshot(storage, input.generation, now);
    clearSnapshotCheck(storage);
    recordSnapshotFailure(storage, input.generation, input.reason, now);
  });
}
