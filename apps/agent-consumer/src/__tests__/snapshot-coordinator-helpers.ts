import type { AgentDeliveryCoordinatorInstance } from '../agent-delivery-coordinator';
import { AGENT_SNAPSHOT_TARGETS, snapshotCopyAttempt } from '../snapshot-tinybird';

export function finishSnapshotCopies(
  coordinator: AgentDeliveryCoordinatorInstance,
  generation: number,
  claimId: string,
) {
  const progress = coordinator.getSnapshotProgress({ generation, claimId });
  for (let copyIndex = progress.nextCopyIndex; copyIndex < progress.totalCopies; copyIndex += 1) {
    const target = AGENT_SNAPSHOT_TARGETS[copyIndex % AGENT_SNAPSHOT_TARGETS.length]!;
    const chunkIndex = Math.floor(copyIndex / AGENT_SNAPSHOT_TARGETS.length);
    const copyAttempt =
      progress.totalCopies === AGENT_SNAPSHOT_TARGETS.length
        ? snapshotCopyAttempt(generation)
        : snapshotCopyAttempt(generation, chunkIndex);
    const key = { generation, target, copyAttempt, claimId, copyIndex };
    coordinator.recordSnapshotCopyIntent({ ...key, startedAt: Date.now() });
    const jobId = `job-${copyIndex}`;
    coordinator.attachSnapshotCopyJob({ ...key, jobId });
    coordinator.settleSnapshotCopyIntent({ ...key, jobId, status: 'done' });
  }
  coordinator.prepareSnapshotManifest({ generation, claimId });
  return coordinator.finishSnapshot({ generation, claimId });
}
