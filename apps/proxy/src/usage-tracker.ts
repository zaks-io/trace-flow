import { axiomConfigFromEnv, createLogger, type TraceContext } from '@trace-flow/logging';
import type { SubscriptionKVData } from '@trace-flow/types';
import { generateTraceId } from '@trace-flow/utils';
import { DurableObject, tracing } from 'cloudflare:workers';
import * as Sentry from '@sentry/cloudflare';
import {
  captureSafeException,
  internalTraceHeaders,
  sentryRequestPrivacy,
  TRACE_FLOW_PROPAGATION_TARGETS,
} from '@trace-flow/utils/sentry-tracing';
import { withNativeTrace } from '@trace-flow/utils/native-tracing';
import { UsagePeriod, type UsageSnapshot } from './usage-period';

interface Env {
  CONVEX_SITE_URL: string;
  USAGE_SYNC_SECRET: string;
  AXIOM_TOKEN?: string;
  AXIOM_DATASET?: string;
  AXIOM_DOMAIN?: string;
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  CF_VERSION_METADATA?: { id: string };
}

interface CheckRequest {
  count: number;
  subscriptionConfig: SubscriptionKVData;
  orgId: string;
}

interface UsageSyncPayload extends UsageSnapshot {
  traceContext?: TraceContext;
}

export function buildUsageSyncRequestInit(secret: string, payload: UsageSyncPayload): RequestInit {
  return {
    method: 'POST',
    headers: internalTraceHeaders({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${secret}`,
    }),
    body: JSON.stringify(payload),
  };
}

export function isPermanentUsageSyncFailure(status: number): boolean {
  return status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429;
}

class UsageTrackerBase extends DurableObject<Env> {
  private period?: UsagePeriod;

  private state() {
    return (this.period ??= new UsagePeriod(this.ctx.storage));
  }

  private async scheduleSync() {
    if (this.state().needsSync() && (await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
    }
  }

  async fetch(request: Request): Promise<Response> {
    return withNativeTrace(tracing, 'trace_flow.usage', async () => {
      const url = new URL(request.url);
      if (url.pathname !== '/check' || request.method !== 'POST') {
        return new Response('Not found', { status: 404 });
      }
      const { count, subscriptionConfig, orgId }: CheckRequest = await request.json();
      const result = this.state().check(orgId, subscriptionConfig, count, Date.now());
      await this.scheduleSync();
      return Response.json(result);
    });
  }

  async alarm() {
    return withNativeTrace(tracing, 'trace_flow.usage_alarm', async () => {
      try {
        for (const snapshot of this.state().pending()) {
          if (!(await this.pushToConvex(snapshot))) break;
          this.state().confirm(snapshot);
        }
      } finally {
        await this.scheduleSync();
      }
    });
  }

  private async pushToConvex(snapshot: UsageSnapshot) {
    const traceContext: TraceContext = {
      traceId: Sentry.getActiveSpan()?.spanContext().traceId ?? generateTraceId(),
      workflowId: `usage:${snapshot.orgId}:${snapshot.periodStart}:${snapshot.periodEnd}`,
      orgId: snapshot.orgId,
    };
    const logger = createLogger({
      service: 'proxy',
      runtime: 'durable-object',
      axiom: axiomConfigFromEnv(this.env),
      context: { component: 'usage-tracker', operation: 'push_usage', ...traceContext },
    });
    try {
      const response = await fetch(
        `${this.env.CONVEX_SITE_URL}/usage/record`,
        buildUsageSyncRequestInit(this.env.USAGE_SYNC_SECRET, { ...snapshot, traceContext }),
      );
      await response.arrayBuffer();
      if (!response.ok) {
        if (isPermanentUsageSyncFailure(response.status)) {
          logger.error('proxy.usage_sync_rejected', { status: response.status });
          return true;
        }
        logger.warn('proxy.usage_sync_failed', { status: response.status });
        throw new Error(`Usage synchronization failed: ${response.status}`);
      }
      logger.info('proxy.usage_synced', {
        subscriptionUnitsUsed: snapshot.subscriptionUnitsUsed,
        addonUnitsUsed: snapshot.addonUnitsUsed,
        periodStart: snapshot.periodStart,
        periodEnd: snapshot.periodEnd,
      });
      return true;
    } catch (error) {
      captureSafeException(error, {
        message: 'Usage alarm synchronization failed',
        operation: 'usage.alarm',
      });
      // The durable minute alarm owns retries; throwing also triggers platform retries.
      return false;
    } finally {
      await logger.flush();
    }
  }
}

export const UsageTracker = Sentry.instrumentDurableObjectWithSentry(
  (env: Env) => ({
    dsn: env.SENTRY_DSN,
    release: env.CF_VERSION_METADATA?.id,
    environment: env.SENTRY_ENVIRONMENT ?? 'development',
    tracesSampleRate: 1,
    enableRpcTracePropagation: true,
    tracePropagationTargets: TRACE_FLOW_PROPAGATION_TARGETS,
    ...sentryRequestPrivacy(),
  }),
  UsageTrackerBase,
);
