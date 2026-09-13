import type { AgentConsumerEnv } from './context';
import { processAgentRecoveryPayload } from './consumer';
import { processMigratedLegacyMessage } from './legacy-delivery';

/** Replays through the accepted delivery path after migration while retaining the legacy path. */
export async function replayAgentDlqPayload(body: unknown, env: AgentConsumerEnv): Promise<void> {
  let confirmed = false;
  const replay = {
    id: crypto.randomUUID(),
    body,
    ack: () => {
      confirmed = true;
    },
    retry: () => {
      throw new Error('Direct DLQ replay cannot schedule a Queue retry');
    },
  } as unknown as Message<unknown>;

  if (await processMigratedLegacyMessage(replay, env)) {
    if (!confirmed) throw new Error('Migrated DLQ replay was not confirmed');
    return;
  }
  await processAgentRecoveryPayload(body, env);
}
