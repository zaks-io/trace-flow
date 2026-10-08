import * as Sentry from '@sentry/cloudflare';
import { axiomConfigFromEnv, createLogger } from '@trace-flow/logging';
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

export async function retryOffContractMessages(
  messages: readonly Message<unknown>[],
  queue: string,
  env: AgentConsumerEnv,
): Promise<void> {
  const logger = createLogger({
    service: 'agent-consumer',
    runtime: 'cloudflare-worker',
    axiom: axiomConfigFromEnv(env),
    context: { component: 'queue-consumer' },
  });
  try {
    for (const message of messages) {
      const extra = { messageId: message.id, queue };
      logger.error('agent_consumer.message_off_contract', undefined, extra);
      Sentry.captureMessage('agent_consumer.message_off_contract', {
        level: 'error',
        tags: { operation: 'guard' },
        extra,
      });
      message.retry();
    }
  } finally {
    await logger.flush();
  }
}
