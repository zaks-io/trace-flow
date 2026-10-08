import { sentryRequestPrivacy } from '@trace-flow/utils/sentry-tracing';
import { DurableObject, tracing } from 'cloudflare:workers';
import { withNativeTrace } from '@trace-flow/utils/native-tracing';
import * as Sentry from '@sentry/cloudflare';
import {
  TRACE_FLOW_PROPAGATION_TARGETS,
  captureSafeException,
  continueQueueTrace,
  durableSentryTraceHeader,
  sentryTraceLinks,
} from '@trace-flow/utils/sentry-tracing';
import type {
  AgentDeliveryReference,
  AgentDeliveryStagedReference,
  AgentIngestQueueMessage,
} from '@trace-flow/types';
import {
  loadAgentDelivery,
  validateAgentDeliveryReference,
  validateAgentDeliveryStagedReference,
} from '@trace-flow/utils';
import type { AgentConsumerEnv } from './context';
import { CATEGORIES, factPartitionKey, type Category } from './facts';
import { loadDeliveryRows, priceDelivery, storeDeliveryRows } from './delivery-rows';
import { deliveryCategoryIsPresent, writeDeliveryCategory } from './delivery-write';
import { deliveryPartitionLinks, prepareDeliveryPartitions } from './delivery-partitions';

interface DeliveryState {
  reference: AgentDeliveryStagedReference;
  days: string[];
  revision?: number;
  rowsSha256?: string;
  plannedDirtyDays?: string[];
  sentryTraceHeader?: string | null;
  categories: Partial<Record<Category, 'attempting' | 'done'>>;
  phase: 'registered' | 'committing' | 'complete' | 'expired';
}

/** One bounded receipt per delivery. Fact bodies exist only in encrypted, expiring R2 objects. */
class AgentDeliveryBase extends DurableObject<AgentConsumerEnv> {
  private tail: Promise<unknown> = Promise.resolve();

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.catch(() => undefined);
    return result;
  }

  receiptReference(orgId: string): Promise<AgentDeliveryStagedReference | null> {
    return this.exclusive(async () => {
      const state = await this.ctx.storage.get<DeliveryState>('receipt');
      if (!state) return null;
      if (state.reference.org_id !== orgId) throw new Error('Delivery receipt tenant mismatch');
      if (state.reference.expires_at <= Date.now()) throw new Error('Delivery receipt expired');
      if ((await this.coordinator(orgId).getErasureState({})) !== null) {
        throw new Error('Organization ingestion erasure has started');
      }
      return state.reference;
    });
  }

  register(reference: AgentDeliveryStagedReference, days: string[]): Promise<number | null> {
    return this.exclusive(() => this.registerInner(reference, days));
  }

  private async registerInner(
    reference: AgentDeliveryStagedReference,
    days: string[],
  ): Promise<number | null> {
    if (validateAgentDeliveryStagedReference(reference))
      throw new Error('Invalid delivery registration');
    if (reference.expires_at <= Date.now()) throw new Error('Delivery registration expired');
    let state = await this.ctx.storage.get<DeliveryState>('receipt');
    if (state) {
      if (
        JSON.stringify(state.reference) !== JSON.stringify(reference) ||
        JSON.stringify(state.days) !== JSON.stringify(days)
      ) {
        throw new Error('Delivery registration conflict');
      }
      if (state.revision !== undefined) {
        if ((await this.coordinator(reference.org_id).getErasureState({})) !== null) {
          throw new Error('Organization ingestion erasure has started');
        }
        return state.revision;
      }
    } else {
      state = {
        reference,
        days,
        categories: {},
        phase: 'registered',
      };
      await this.ctx.storage.put('receipt', state);
    }
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
    const coordinator = this.coordinator(reference.org_id);
    let result: Awaited<ReturnType<typeof coordinator.reserve>>;
    try {
      result = await coordinator.reserve({
        deliveryId: reference.key,
        payloadSha256: reference.sha256,
        dirtyDays: days,
        createdAtMs: reference.created_at,
        expiresAtMs: reference.expires_at,
      });
    } catch (error) {
      try {
        const erasure = await coordinator.getErasureState({});
        if (erasure !== null) {
          const reservation = await coordinator.getReservation({ deliveryId: reference.key });
          if (reservation === null) {
            await this.removeBodies(state);
            await this.clearReceipt();
          }
        }
      } catch {
        // Preserve the staged body when the coordinator cannot prove it is safe to discard.
      }
      throw error;
    }
    if (result === null) return null;
    state.revision = result.deliverySequence;
    await this.ctx.storage.put('receipt', state);
    return result.deliverySequence;
  }

  process(reference: AgentDeliveryReference): Promise<'complete' | 'retry'> {
    return this.exclusive(async () => {
      try {
        return await this.processWithTrace(reference);
      } catch (error) {
        const failure =
          error instanceof Error ? error : new Error('Agent delivery processing failed');
        captureSafeException(failure, {
          message: 'Agent delivery processing failed',
          operation: 'agent_delivery.process',
        });
        throw failure;
      }
    });
  }

  private async processWithTrace(reference: AgentDeliveryReference): Promise<'complete' | 'retry'> {
    if (validateAgentDeliveryReference(reference)) throw new Error('Invalid agent delivery');
    const state = await this.ctx.storage.get<DeliveryState>('receipt');
    if (
      state?.reference.key !== reference.key ||
      state.reference.sha256 !== reference.sha256 ||
      state.reference.org_id !== reference.org_id ||
      state.reference.created_at !== reference.created_at ||
      state.reference.expires_at !== reference.expires_at
    ) {
      throw new Error('Agent delivery does not match its registered receipt');
    }
    if (state.revision === undefined && state.phase === 'registered') {
      // A reserve RPC reply can be lost after the coordinator commits. A predecessor may then
      // queue this reservation before the receipt's recovery alarm has persisted its revision.
      const reservation = await this.coordinator(reference.org_id).getReservation({
        deliveryId: reference.key,
      });
      if (
        reservation?.deliveryId !== reference.key ||
        reservation.payloadSha256 !== reference.sha256 ||
        reservation.createdAtMs !== reference.created_at ||
        reservation.expiresAtMs !== reference.expires_at ||
        reservation.deliverySequence !== reference.delivery_revision ||
        JSON.stringify(reservation.dirtyDays) !== JSON.stringify([...new Set(state.days)].sort())
      ) {
        throw new Error('Agent delivery does not match its registered receipt');
      }
      state.revision = reservation.deliverySequence;
      await this.ctx.storage.put('receipt', state);
    }
    if (state.revision !== reference.delivery_revision) {
      throw new Error('Agent delivery does not match its registered receipt');
    }
    if (state.phase === 'complete') {
      await this.removeBodies(state);
      return 'complete';
    }
    if (reference.expires_at <= Date.now() || state.phase === 'expired') {
      throw new Error('Agent delivery expired before completion');
    }
    let source: AgentIngestQueueMessage | undefined;
    if (!state.rowsSha256 && state.sentryTraceHeader === undefined) {
      source = await this.loadQueueDelivery(reference);
      state.sentryTraceHeader = durableSentryTraceHeader(source.sentry_trace_context);
      await this.ctx.storage.put('receipt', state);
    }
    const process = async (): Promise<'complete' | 'retry'> => {
      try {
        return await this.processInner(state, reference, source);
      } catch (error) {
        const failure =
          error instanceof Error ? error : new Error('Agent delivery processing failed');
        captureSafeException(failure, {
          message: 'Agent delivery processing failed',
          operation: 'agent_delivery.process',
        });
        throw failure;
      }
    };
    // Committing receipts may outlive their source. Tracing must not require a deleted body.
    if (!state.sentryTraceHeader) return process();
    const invokingSpan = Sentry.getActiveSpan();
    return continueQueueTrace(
      { 'sentry-trace': state.sentryTraceHeader },
      {
        queueName: 'agent-delivery',
        messageCount: 1,
        attributes: {
          'trace_flow.delivery.key': reference.key,
          'trace_flow.delivery.revision': reference.delivery_revision,
        },
        links: invokingSpan ? [{ context: invokingSpan.spanContext() }] : undefined,
      },
      () =>
        withNativeTrace(tracing, 'agent delivery processing', process, {
          deliveryId: reference.key,
        }),
    );
  }

  private async processInner(
    state: DeliveryState,
    reference: AgentDeliveryReference,
    source?: AgentIngestQueueMessage,
  ): Promise<'complete' | 'retry'> {
    const coordinator = this.coordinator(reference.org_id);
    const { reservation, writePermit } = await coordinator.beginWrite({
      deliveryId: reference.key,
      payloadSha256: reference.sha256,
    });
    if (
      state.phase !== 'committing' &&
      (reservation?.payloadSha256 !== reference.sha256 ||
        reservation.deliverySequence !== reference.delivery_revision)
    ) {
      throw new Error('Agent delivery reservation is missing or inconsistent');
    }
    if (reservation && !writePermit) return 'retry';
    if (state.phase === 'committing') {
      await this.finishCommit(state, reference, coordinator, reservation !== null);
      return 'complete';
    }
    const rowsKey = this.rowsKey(reference.key);
    if (!state.rowsSha256) {
      const priced = await this.priceQueueDelivery(reference, source);
      await prepareDeliveryPartitions(this.env, priced);
      state.rowsSha256 = await storeDeliveryRows(this.env, rowsKey, priced);
      await this.ctx.storage.put('receipt', state);
    }
    const delivery = await loadDeliveryRows(this.env, rowsKey, {
      orgId: reference.org_id,
      revision: reference.delivery_revision,
      expiresAt: reference.expires_at,
      sha256: state.rowsSha256,
    });
    const dirtyDays = [
      ...new Set(
        CATEGORIES.flatMap((category) =>
          delivery.rows[category].map((row) => factPartitionKey(category, row)),
        ),
      ),
    ].sort();
    if (state.plannedDirtyDays === undefined) {
      state.plannedDirtyDays = dirtyDays;
      await this.ctx.storage.put('receipt', state);
    } else if (JSON.stringify(state.plannedDirtyDays) !== JSON.stringify(dirtyDays)) {
      throw new Error('Stored delivery plan dirty days changed');
    }
    if (reservation)
      await coordinator.planWrite({
        deliveryId: reference.key,
        payloadSha256: reference.sha256,
        dirtyDays,
        links: deliveryPartitionLinks(delivery),
      });
    for (const category of CATEGORIES) {
      const rows = delivery.rows[category];
      if (state.categories[category] === 'done' || rows.length === 0) continue;
      if (
        state.categories[category] !== 'attempting' ||
        !(await deliveryCategoryIsPresent(
          this.env,
          reference.org_id,
          reference.delivery_revision,
          category,
          rows,
        ))
      ) {
        state.categories[category] = 'attempting';
        await this.ctx.storage.put('receipt', state);
        await writeDeliveryCategory(this.env, category, rows);
      }
      state.categories[category] = 'done';
      await this.ctx.storage.put('receipt', state);
    }
    state.phase = 'committing';
    await this.ctx.storage.put('receipt', state);
    await this.finishCommit(state, reference, coordinator, reservation !== null);
    return 'complete';
  }

  async alarm(): Promise<void> {
    await this.exclusive(async () => {
      try {
        await this.runAlarm();
      } catch (error) {
        const failure = error instanceof Error ? error : new Error('Agent delivery alarm failed');
        captureSafeException(failure, {
          message: 'Agent delivery alarm failed',
          operation: 'agent_delivery.alarm',
        });
        throw failure;
      }
    });
  }

  private async runAlarm(): Promise<void> {
    const state = await this.ctx.storage.get<DeliveryState>('receipt');
    if (!state) return;
    Sentry.getActiveSpan()?.addLinks(sentryTraceLinks([state.sentryTraceHeader]));
    if (state.phase === 'complete') {
      await this.removeBodies(state);
      if (Date.now() >= state.reference.expires_at) await this.clearReceipt();
      else await this.ctx.storage.setAlarm(state.reference.expires_at);
      return;
    }
    if (Date.now() >= state.reference.expires_at) {
      state.phase = 'expired';
      await this.ctx.storage.put('receipt', state);
      const coordinator = this.coordinator(state.reference.org_id);
      const reservation = await coordinator.getReservation({ deliveryId: state.reference.key });
      if (reservation)
        await coordinator.expire({
          deliveryId: state.reference.key,
          payloadSha256: state.reference.sha256,
        });
      Sentry.captureMessage('agent_consumer.delivery_expired_incomplete', {
        level: 'error',
        extra: { orgId: state.reference.org_id, dirtyDays: state.days },
      });
      await this.removeBodies(state);
      await this.clearReceipt();
      return;
    }
    await this.ctx.storage.setAlarm(Math.min(Date.now() + 60_000, state.reference.expires_at));
    const revision = state.revision ?? (await this.registerInner(state.reference, state.days));
    if (revision === null) return;
    await this.env.AGENT_QUEUE.send({ ...state.reference, delivery_revision: revision });
  }

  private async finishCommit(
    state: DeliveryState,
    reference: AgentDeliveryReference,
    coordinator: ReturnType<AgentDeliveryBase['coordinator']>,
    hasReservation: boolean,
  ): Promise<void> {
    if (state.plannedDirtyDays === undefined) {
      throw new Error('Committing delivery has no persisted dirty day plan');
    }
    const { next } = await coordinator.finishDelivery({
      deliveryId: reference.key,
      payloadSha256: reference.sha256,
      orgId: reference.org_id,
      hasReservation,
      plannedDirtyDays: state.plannedDirtyDays,
    });
    if (next) {
      const wake: AgentDeliveryReference = {
        type: 'agent-delivery',
        version: 1,
        key: next.deliveryId,
        org_id: reference.org_id,
        sha256: next.payloadSha256,
        created_at: next.createdAtMs,
        expires_at: next.expiresAtMs,
        delivery_revision: next.deliverySequence,
      };
      if (validateAgentDeliveryReference(wake)) throw new Error('Invalid next delivery reference');
      await this.env.AGENT_QUEUE.send(wake);
    }
    state.phase = 'complete';
    await this.ctx.storage.put('receipt', state);
    await this.removeBodies(state);
    await this.ctx.storage.setAlarm(reference.expires_at);
  }

  private coordinator(orgId: string) {
    return this.env.AGENT_DELIVERY_COORDINATOR.getByName(`org:${orgId}`);
  }

  private async loadQueueDelivery(reference: AgentDeliveryReference) {
    return loadAgentDelivery({
      storage: this.env.AGENT_DELIVERIES,
      reference,
      encryption: { rootKeyBase64: this.env.BODY_ENCRYPTION_ROOT_KEY },
    });
  }

  private async priceQueueDelivery(
    reference: AgentDeliveryReference,
    source?: AgentIngestQueueMessage,
  ) {
    const message = source ?? (await this.loadQueueDelivery(reference));
    return priceDelivery(
      message,
      reference.delivery_revision,
      reference.expires_at,
      this.env.MODEL_PRICING,
    );
  }

  private rowsKey(key: string): string {
    return key.replace('agent-deliveries/', 'agent-delivery-rows/');
  }

  private async removeBodies(state: DeliveryState): Promise<void> {
    await this.env.AGENT_DELIVERIES.delete([
      state.reference.key,
      this.rowsKey(state.reference.key),
    ]);
  }

  private async clearReceipt(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}

export const AgentDelivery = Sentry.instrumentDurableObjectWithSentry(
  (env: AgentConsumerEnv) => ({
    dsn: env.SENTRY_DSN,
    release: env.CF_VERSION_METADATA?.id,
    environment: env.SENTRY_ENVIRONMENT ?? 'development',
    tracesSampleRate: 1,
    tracePropagationTargets: TRACE_FLOW_PROPAGATION_TARGETS,
    ...sentryRequestPrivacy(),
    enableRpcTracePropagation: true,
    rpcTracePropagationBindings: ['AGENT_DELIVERY_COORDINATOR'],
  }),
  AgentDeliveryBase,
);
export type AgentDeliveryInstance = InstanceType<typeof AgentDelivery>;
