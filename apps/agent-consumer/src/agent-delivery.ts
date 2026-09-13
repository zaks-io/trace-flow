import { DurableObject } from 'cloudflare:workers';
import * as Sentry from '@sentry/cloudflare';
import { TRACE_FLOW_PROPAGATION_TARGETS } from '@trace-flow/utils/sentry-tracing';
import type { AgentDeliveryReference, AgentDeliveryStagedReference } from '@trace-flow/types';
import {
  loadAgentDelivery,
  validateAgentDeliveryReference,
  validateAgentDeliveryStagedReference,
} from '@trace-flow/utils';
import type { AgentConsumerEnv } from './context';
import { CATEGORIES, factPartitionKey, type Category } from './facts';
import {
  loadDeliveryRows,
  priceDelivery,
  storeDeliveryRows,
  versionDeliveryRows,
} from './delivery-rows';
import { deliveryCategoryIsPresent, writeDeliveryCategory } from './delivery-write';
import { deliveryPartitionLinks, prepareDeliveryPartitions } from './delivery-partitions';
import {
  assertExpectedCanonicalFacts,
  validateExpectedCanonicalProof,
  type ExpectedCanonicalFact,
} from './frozen-fact-recovery';

interface DeliveryState {
  reference: AgentDeliveryStagedReference;
  days: string[];
  inputFormat: 'queue' | 'priced';
  canonicalProof?: ExpectedCanonicalFact[];
  revision?: number;
  rowsSha256?: string;
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

  register(reference: AgentDeliveryStagedReference, days: string[]): Promise<number> {
    return this.exclusive(() => this.registerInner(reference, days, 'queue'));
  }

  registerPricedRecovery(
    reference: AgentDeliveryStagedReference,
    days: string[],
    canonicalProof?: ExpectedCanonicalFact[],
  ): Promise<number> {
    const validatedProof = canonicalProof
      ? validateExpectedCanonicalProof(canonicalProof)
      : undefined;
    return this.exclusive(() => this.registerInner(reference, days, 'priced', validatedProof));
  }

  private async registerInner(
    reference: AgentDeliveryStagedReference,
    days: string[],
    inputFormat: DeliveryState['inputFormat'],
    canonicalProof?: ExpectedCanonicalFact[],
  ): Promise<number> {
    if (validateAgentDeliveryStagedReference(reference))
      throw new Error('Invalid delivery registration');
    if (reference.expires_at <= Date.now()) throw new Error('Delivery registration expired');
    let state = await this.ctx.storage.get<DeliveryState>('receipt');
    if (state) {
      if (
        JSON.stringify(state.reference) !== JSON.stringify(reference) ||
        JSON.stringify(state.days) !== JSON.stringify(days) ||
        state.inputFormat !== inputFormat ||
        JSON.stringify(state.canonicalProof) !== JSON.stringify(canonicalProof)
      ) {
        throw new Error('Delivery registration conflict');
      }
      if (state.revision !== undefined) return state.revision;
    } else {
      state = {
        reference,
        days,
        inputFormat,
        ...(canonicalProof ? { canonicalProof } : {}),
        categories: {},
        phase: 'registered',
      };
      await this.ctx.storage.put('receipt', state);
    }
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
    const result = await this.coordinator(reference.org_id).reserve({
      deliveryId: reference.key,
      payloadSha256: reference.sha256,
      dirtyDays: days,
      createdAtMs: reference.created_at,
      expiresAtMs: reference.expires_at,
    });
    state.revision = result.deliverySequence;
    await this.ctx.storage.put('receipt', state);
    return result.deliverySequence;
  }

  process(reference: AgentDeliveryReference): Promise<void> {
    return this.exclusive(async () => {
      if (validateAgentDeliveryReference(reference)) throw new Error('Invalid agent delivery');
      const state = await this.ctx.storage.get<DeliveryState>('receipt');
      if (
        state?.reference.key !== reference.key ||
        state.reference.sha256 !== reference.sha256 ||
        state.reference.org_id !== reference.org_id ||
        state.reference.created_at !== reference.created_at ||
        state.reference.expires_at !== reference.expires_at ||
        state.revision !== reference.delivery_revision
      ) {
        throw new Error('Agent delivery does not match its registered receipt');
      }
      if (state.phase === 'complete') {
        await this.removeBodies(state);
        return;
      }
      if (reference.expires_at <= Date.now() || state.phase === 'expired') {
        throw new Error('Agent delivery expired before completion');
      }
      const coordinator = this.coordinator(reference.org_id);
      const reservation = await coordinator.getReservation({ deliveryId: reference.key });
      if (
        state.phase !== 'committing' &&
        (reservation?.payloadSha256 !== reference.sha256 ||
          reservation.deliverySequence !== reference.delivery_revision)
      ) {
        throw new Error('Agent delivery reservation is missing or inconsistent');
      }
      if (
        reservation &&
        !(await coordinator.acquireWrite({
          deliveryId: reference.key,
          payloadSha256: reference.sha256,
        }))
      )
        throw new Error('Agent delivery is waiting for earlier accepted work');
      if (state.phase === 'committing') {
        await this.finishCommit(state, reference, coordinator, reservation !== null);
        return;
      }
      const rowsKey = this.rowsKey(reference.key);
      let canonicalProofChecked = false;
      if (!state.rowsSha256) {
        const priced =
          state.inputFormat === 'queue'
            ? await this.priceQueueDelivery(reference)
            : await this.loadPricedRecovery(reference);
        if (state.canonicalProof) {
          await assertExpectedCanonicalFacts(this.env, priced, state.canonicalProof);
          canonicalProofChecked = true;
        }
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
      if (state.canonicalProof && !canonicalProofChecked) {
        await assertExpectedCanonicalFacts(this.env, delivery, state.canonicalProof);
      }
      if (reservation)
        await coordinator.expandDirtyDays({
          deliveryId: reference.key,
          payloadSha256: reference.sha256,
          dirtyDays: [
            ...new Set(
              CATEGORIES.flatMap((category) =>
                delivery.rows[category].map((row) => factPartitionKey(category, row)),
              ),
            ),
          ].sort(),
        });
      const links = deliveryPartitionLinks(delivery);
      if (reservation && links.length > 0)
        await coordinator.linkDirtyDays({
          deliveryId: reference.key,
          payloadSha256: reference.sha256,
          links,
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
    });
  }

  async alarm(): Promise<void> {
    await this.exclusive(async () => {
      const state = await this.ctx.storage.get<DeliveryState>('receipt');
      if (!state) return;
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
      const revision =
        state.revision ??
        (await this.registerInner(
          state.reference,
          state.days,
          state.inputFormat,
          state.canonicalProof,
        ));
      await this.env.AGENT_QUEUE.send({ ...state.reference, delivery_revision: revision });
    });
  }

  private async finishCommit(
    state: DeliveryState,
    reference: AgentDeliveryReference,
    coordinator: ReturnType<AgentDeliveryBase['coordinator']>,
    hasReservation: boolean,
  ): Promise<void> {
    if (hasReservation)
      await coordinator.complete({ deliveryId: reference.key, payloadSha256: reference.sha256 });
    await coordinator.scheduleSnapshot({ orgId: reference.org_id });
    const next = await coordinator.getNextDelivery();
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

  private async priceQueueDelivery(reference: AgentDeliveryReference) {
    const message = await loadAgentDelivery({
      storage: this.env.AGENT_DELIVERIES,
      reference,
      encryption: { rootKeyBase64: this.env.BODY_ENCRYPTION_ROOT_KEY },
    });
    return priceDelivery(
      message,
      reference.delivery_revision,
      reference.expires_at,
      this.env.MODEL_PRICING,
    );
  }

  private async loadPricedRecovery(reference: AgentDeliveryReference) {
    const source = await loadDeliveryRows(this.env, reference.key, {
      orgId: reference.org_id,
      revision: 1,
      expiresAt: reference.expires_at,
      sha256: reference.sha256,
    });
    return versionDeliveryRows(source.rows, {
      orgId: reference.org_id,
      revision: reference.delivery_revision,
      expiresAt: reference.expires_at,
    });
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
    enableRpcTracePropagation: true,
  }),
  AgentDeliveryBase,
);
export type AgentDeliveryInstance = InstanceType<typeof AgentDelivery>;
