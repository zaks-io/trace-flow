import { AGENT_DEAD_LETTERS_INSTANCE_NAME } from './dead-letters';
import type { AgentConsumerEnv } from './context';
import { discoverSnapshotCopy } from './snapshot-tinybird';

async function settleOutstandingSnapshotCopies(
  env: AgentConsumerEnv,
  orgId: string,
): Promise<void> {
  const coordinator = env.AGENT_DELIVERY_COORDINATOR.getByName(`org:${orgId}`);
  const intents = await coordinator.getOutstandingSnapshotCopyIntents({});
  for (let offset = 0; offset < intents.length; offset += 4) {
    await Promise.all(
      intents.slice(offset, offset + 4).map(async (intent) => {
        const job = await discoverSnapshotCopy(env, orgId, intent);
        if (!job) return;
        const key = {
          generation: intent.generation,
          target: intent.target,
          copyAttempt: intent.copyAttempt,
        };
        if (!intent.jobId) {
          await coordinator.attachErasureSnapshotCopyJob({ ...key, jobId: job.id });
        }
        if (job.status === 'done' || job.status === 'error') {
          await coordinator.settleErasureSnapshotCopyIntent({
            ...key,
            jobId: job.id,
            status: job.status,
          });
        }
      }),
    );
  }
}

export async function eraseAgentOrganization(
  env: AgentConsumerEnv,
  orgId: string,
  afterId?: number,
): Promise<{ ready: boolean; nextAfterId?: number }> {
  const coordinator = env.AGENT_DELIVERY_COORDINATOR.getByName(`org:${orgId}`);
  await coordinator.beginErasure({});
  await settleOutstandingSnapshotCopies(env, orgId);
  let state = await coordinator.getErasureState({});
  if (state?.activeSnapshotGeneration !== null && state?.outstandingCopyIntents === 0) {
    await coordinator.abandonErasureSnapshot({ generation: state.activeSnapshotGeneration });
    state = await coordinator.getErasureState({});
  }
  if (!state?.ready) return { ready: false };
  const dlq = await env.AGENT_DEAD_LETTERS.getByName(
    AGENT_DEAD_LETTERS_INSTANCE_NAME,
  ).discardOrganizationDlq(orgId, {
    afterId,
    limit: 100,
  });
  if (dlq.nextAfterId !== null) return { ready: false, nextAfterId: dlq.nextAfterId };
  let remaining = false;
  for (const prefix of [`agent-deliveries/${orgId}/`, `agent-delivery-rows/${orgId}/`]) {
    const page = await env.AGENT_DELIVERIES.list({ prefix, limit: 1000 });
    if (page.objects.length > 0)
      await env.AGENT_DELIVERIES.delete(page.objects.map((object) => object.key));
    remaining ||= page.truncated;
  }
  return { ready: !remaining };
}

export async function organizationErasureStarted(
  env: AgentConsumerEnv,
  orgId: string,
): Promise<boolean> {
  const coordinator = env.AGENT_DELIVERY_COORDINATOR.getByName(`org:${orgId}`);
  return (await coordinator.getErasureState({})) !== null;
}
