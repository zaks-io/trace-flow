import { isAgentDeliveryReference } from '@trace-flow/utils';
import { captureSafeException } from '@trace-flow/utils/sentry-tracing';
import type { AgentConsumerEnv } from './context';

const CONCURRENT_DELIVERIES = 6;

export async function processDeliveryReferences(
  messages: readonly Message<unknown>[],
  env: AgentConsumerEnv,
): Promise<void> {
  for (let offset = 0; offset < messages.length; offset += CONCURRENT_DELIVERIES) {
    await Promise.all(
      messages.slice(offset, offset + CONCURRENT_DELIVERIES).map(async (message) => {
        try {
          if (!isAgentDeliveryReference(message.body))
            throw new Error('Invalid agent delivery reference');
          const result = await env.AGENT_DELIVERY.getByName(message.body.key).process(message.body);
          if (result === 'retry') message.retry({ delaySeconds: 60 });
          else if (result === 'complete') message.ack();
          else throw new Error('Invalid agent delivery result');
        } catch (error) {
          message.retry({ delaySeconds: 60 });
          // Remote platform failures do not prove the receiver executed or captured an error.
          captureSafeException(error, {
            message: 'Agent delivery dispatch failed',
            operation: 'agent_delivery.dispatch',
          });
        }
      }),
    );
  }
}

export function hasDeliveryReferenceType(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    'type' in value &&
    value.type === 'agent-delivery'
  );
}
