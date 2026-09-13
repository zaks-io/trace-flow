import type { AgentConsumerEnv } from './context';
import type { AgentFactBatcherInstance } from './fact-batcher';
import { storeDeliveryRowsOnce } from './delivery-rows';
import {
  buildFrozenDelivery,
  canonicalProof,
  frozenDeliveryDays,
  frozenDeliveryReference,
  validateReplayFrozenFactsInput,
  type ReplayFrozenFactsInput,
} from './frozen-fact-recovery';

export interface FrozenFactReplayConfirmation {
  status: 'confirmed';
  deliveryId: string;
  deliverySequence: number;
  sourceSha256: string;
  factCount: number;
}

export async function replayFrozenFactSelection(
  env: AgentConsumerEnv,
  orgId: string,
  input: ReplayFrozenFactsInput,
  batcher: DurableObjectStub<AgentFactBatcherInstance>,
): Promise<FrozenFactReplayConfirmation> {
  const validated = validateReplayFrozenFactsInput(input);
  const sources = await batcher.readFrozenFacts(orgId, {
    facts: validated.facts.map(({ category, factId, expectedSourceHash }) => ({
      category,
      factId,
      expectedSourceHash,
    })),
  });
  const deliveryRows = buildFrozenDelivery(orgId, validated.createdAtMs, sources);
  const key = `agent-deliveries/${orgId}/${validated.deliveryId}`;
  const sourceSha256 = await storeDeliveryRowsOnce(env, key, deliveryRows);
  const reference = frozenDeliveryReference(
    validated.deliveryId,
    validated.createdAtMs,
    orgId,
    sourceSha256,
  );
  const delivery = env.AGENT_DELIVERY.getByName(reference.key);
  const deliverySequence = await delivery.registerPricedRecovery(
    reference,
    frozenDeliveryDays(deliveryRows),
    canonicalProof(validated),
  );
  await delivery.process({ ...reference, delivery_revision: deliverySequence });
  return {
    status: 'confirmed',
    deliveryId: validated.deliveryId,
    deliverySequence,
    sourceSha256,
    factCount: sources.length,
  };
}
