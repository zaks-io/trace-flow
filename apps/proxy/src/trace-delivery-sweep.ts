import { DurableObject } from 'cloudflare:workers';
import * as Sentry from '@sentry/cloudflare';
import { axiomConfigFromEnv, createLogger } from '@trace-flow/logging';
import {
  sentryRequestPrivacy,
  TRACE_FLOW_PROPAGATION_TARGETS,
} from '@trace-flow/utils/sentry-tracing';
import type { ProxyEnv } from './context';
import { validateNamespace } from './delivery';
import { TRACE_DELIVERY_PREFIX } from '@trace-flow/utils';
import { createSweepMetrics, sweepTraceDeliveries } from './delivery-sweep';

interface SweepPosition {
  namespace: string;
  startAfter?: string;
  passStartedAt: number;
}

class TraceDeliverySweepBase extends DurableObject<ProxyEnv> {
  private running = false;

  async run(cron: string): Promise<void> {
    const logger = createLogger({
      service: 'proxy',
      runtime: 'durable-object',
      axiom: axiomConfigFromEnv(this.env),
      context: { component: 'trace-delivery-sweep' },
    });
    const context = { cron, environment: this.env.TRACE_DELIVERY_NAMESPACE };
    if (this.running) {
      logger.info('proxy.delivery_sweep_skipped', { ...context, reason: 'already_running' });
      await logger.flush();
      return;
    }
    this.running = true;
    const metrics = createSweepMetrics(false);
    try {
      const namespace = validateNamespace(this.env.TRACE_DELIVERY_NAMESPACE);
      const position = (await this.ctx.storage.get<SweepPosition>('position')) ?? {
        namespace,
        passStartedAt: Date.now(),
      };
      if (
        position.namespace !== namespace ||
        !Number.isFinite(position.passStartedAt) ||
        (position.startAfter !== undefined &&
          !position.startAfter.startsWith(`${TRACE_DELIVERY_PREFIX}${namespace}-`))
      ) {
        throw new Error('Invalid trace delivery sweep position');
      }
      metrics.resumed = position.startAfter !== undefined;
      await this.ctx.storage.put('position', position);
      try {
        await sweepTraceDeliveries(this.env.STORAGE, this.env.REQUEST_QUEUE, logger, namespace, {
          startAfter: position.startAfter,
          metrics,
          checkpoint: async (startAfter) => {
            if (startAfter === undefined) await this.ctx.storage.delete('position');
            else await this.ctx.storage.put('position', { ...position, startAfter });
          },
        });
      } finally {
        metrics.passAgeMs = Date.now() - position.passStartedAt;
      }
      logger.info('proxy.delivery_sweep_completed', { ...context, ...metrics });
    } catch (error) {
      logger.error('proxy.delivery_sweep_failed', error, { ...context, ...metrics });
      throw error;
    } finally {
      try {
        await logger.flush();
      } finally {
        this.running = false;
      }
    }
  }
}

export const TraceDeliverySweep = Sentry.instrumentDurableObjectWithSentry(
  (env: ProxyEnv) => ({
    dsn: env.SENTRY_DSN,
    release: env.CF_VERSION_METADATA?.id,
    environment: env.SENTRY_ENVIRONMENT ?? 'development',
    tracesSampleRate: 1,
    enableRpcTracePropagation: true,
    tracePropagationTargets: TRACE_FLOW_PROPAGATION_TARGETS,
    ...sentryRequestPrivacy(),
  }),
  TraceDeliverySweepBase,
);
