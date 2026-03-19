import {
  axiomConfigFromEnv,
  createLogger,
  traceContextToHeaders,
  type Logger,
  type TraceContext,
} from '@trace-flow/logging';
import type { SubscriptionKVData } from '@trace-flow/types';
import { generateTraceId } from '@trace-flow/utils';
import { DurableObject } from 'cloudflare:workers';

interface Env {
  CONVEX_SITE_URL: string;
  USAGE_SYNC_SECRET: string;
  AXIOM_TOKEN?: string;
  AXIOM_DATASET?: string;
  AXIOM_DOMAIN?: string;
}

interface CheckRequest {
  count: number;
  subscriptionConfig: SubscriptionKVData;
  orgId: string;
}

interface ConfigRow {
  org_id: string;
  tier: string;
  monthly_units: number;
  addon_units: number;
  period_start: number;
  period_end: number;
}

interface UsageSyncPayload {
  orgId: string;
  periodStart: number;
  periodEnd: number;
  subscriptionUnitsUsed: number;
  addonUnitsUsed: number;
  traceContext?: TraceContext;
}

export function buildUsageSyncRequestInit(secret: string, payload: UsageSyncPayload): RequestInit {
  return {
    method: 'POST',
    headers: traceContextToHeaders(payload.traceContext ?? {}, {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${secret}`,
    }),
    body: JSON.stringify(payload),
  };
}

export class UsageTracker extends DurableObject<Env> {
  private initialized = false;

  private createTraceContext(orgId: string, periodStart: number, periodEnd: number): TraceContext {
    return {
      traceId: generateTraceId(),
      workflowId: `usage:${orgId}:${periodStart}:${periodEnd}`,
      orgId,
    };
  }

  private createUsageLogger(traceContext: TraceContext) {
    return createLogger({
      service: 'proxy',
      runtime: 'durable-object',
      axiom: axiomConfigFromEnv(this.env),
      context: {
        component: 'usage-tracker',
        operation: 'push_usage',
        ...traceContext,
      },
    });
  }

  private ensureTables() {
    if (this.initialized) return;

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS config (
        id INTEGER PRIMARY KEY DEFAULT 1,
        org_id TEXT NOT NULL,
        tier TEXT NOT NULL,
        monthly_units INTEGER NOT NULL,
        addon_units INTEGER NOT NULL,
        period_start INTEGER NOT NULL,
        period_end INTEGER NOT NULL
      )
    `);

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS counters (
        id INTEGER PRIMARY KEY DEFAULT 1,
        subscription_units_used INTEGER NOT NULL DEFAULT 0,
        addon_units_used INTEGER NOT NULL DEFAULT 0,
        addon_baseline INTEGER NOT NULL DEFAULT 0,
        last_pushed_subscription INTEGER NOT NULL DEFAULT 0,
        last_pushed_addon INTEGER NOT NULL DEFAULT 0
      )
    `);

    this.initialized = true;
  }

  private getConfig(): ConfigRow | null {
    const rows = this.ctx.storage.sql
      .exec(
        'SELECT org_id, tier, monthly_units, addon_units, period_start, period_end FROM config WHERE id = 1',
      )
      .toArray();
    if (rows.length === 0) return null;
    return rows[0] as unknown as ConfigRow;
  }

  private requireConfig(): ConfigRow {
    const config = this.getConfig();
    if (!config) throw new Error('Config row missing after write — this is a bug');
    return config;
  }

  private getCounters(): {
    subscription_units_used: number;
    addon_units_used: number;
    addon_baseline: number;
    last_pushed_subscription: number;
    last_pushed_addon: number;
  } {
    const rows = this.ctx.storage.sql
      .exec(
        'SELECT subscription_units_used, addon_units_used, addon_baseline, last_pushed_subscription, last_pushed_addon FROM counters WHERE id = 1',
      )
      .toArray();
    if (rows.length === 0) {
      return {
        subscription_units_used: 0,
        addon_units_used: 0,
        addon_baseline: 0,
        last_pushed_subscription: 0,
        last_pushed_addon: 0,
      };
    }
    return rows[0] as unknown as {
      subscription_units_used: number;
      addon_units_used: number;
      addon_baseline: number;
      last_pushed_subscription: number;
      last_pushed_addon: number;
    };
  }

  private seedConfig(subConfig: SubscriptionKVData, orgId: string) {
    const periodStart = subConfig.currentPeriodStart ?? Date.now();
    const periodEnd = subConfig.currentPeriodEnd ?? periodStart + 30 * 24 * 60 * 60 * 1000;

    this.ctx.storage.sql.exec(
      'INSERT OR REPLACE INTO config (id, org_id, tier, monthly_units, addon_units, period_start, period_end) VALUES (1, ?, ?, ?, ?, ?, ?)',
      orgId,
      subConfig.tier,
      subConfig.monthlyUnits,
      subConfig.addonUnits,
      periodStart,
      periodEnd,
    );

    this.ctx.storage.sql.exec(
      'INSERT OR REPLACE INTO counters (id, subscription_units_used, addon_units_used, addon_baseline, last_pushed_subscription, last_pushed_addon) VALUES (1, 0, 0, 0, 0, 0)',
    );
  }

  private updateConfig(subConfig: SubscriptionKVData) {
    const nextPeriodStart = subConfig.currentPeriodStart ?? this.requireConfig().period_start;
    const nextPeriodEnd = subConfig.currentPeriodEnd ?? this.requireConfig().period_end;
    this.ctx.storage.sql.exec(
      'UPDATE config SET tier = ?, monthly_units = ?, addon_units = ?, period_start = ?, period_end = ? WHERE id = 1',
      subConfig.tier,
      subConfig.monthlyUnits,
      subConfig.addonUnits,
      nextPeriodStart,
      nextPeriodEnd,
    );
  }

  private async handlePeriodRollover() {
    const config = this.getConfig();
    if (!config) {
      throw new Error('UsageTracker rollover: no config row found');
    }

    const now = Date.now();
    if (now < config.period_end) return;

    // Push final totals for completed period before resetting.
    // If push fails, proceed with reset — the alarm will retry the push.
    // This avoids blocking all capture during transient Convex outages.
    await this.ctx.blockConcurrencyWhile(async () => {
      const traceContext = this.createTraceContext(
        config.org_id,
        config.period_start,
        config.period_end,
      );
      const logger = this.createUsageLogger(traceContext);
      try {
        await this.pushToConvex(
          config.org_id,
          config.period_start,
          config.period_end,
          logger,
          traceContext,
        );
      } catch (e) {
        logger.error('proxy.usage_rollover_push_failed', e);
      } finally {
        await logger.flush();
      }
    });

    // If Stripe sync lags, roll period forward by prior duration so requests keep flowing.
    const periodDuration = Math.max(1, config.period_end - config.period_start);
    let periodStart = config.period_start;
    let periodEnd = config.period_end;
    while (Date.now() >= periodEnd) {
      periodStart = periodEnd;
      periodEnd = periodEnd + periodDuration;
    }

    // Reset subscription counters; addon_units_used does NOT reset (addon units persist until used)
    // Snapshot current addon_units_used as baseline so pushToConvex reports only incremental usage per period
    const counters = this.getCounters();

    this.ctx.storage.sql.exec(
      'UPDATE config SET period_start = ?, period_end = ? WHERE id = 1',
      periodStart,
      periodEnd,
    );

    this.ctx.storage.sql.exec(
      'UPDATE counters SET subscription_units_used = 0, addon_baseline = ?, last_pushed_subscription = 0, last_pushed_addon = 0 WHERE id = 1',
      counters.addon_units_used,
    );
  }

  private configChanged(current: ConfigRow, incoming: SubscriptionKVData): boolean {
    return (
      current.tier !== incoming.tier ||
      current.monthly_units !== incoming.monthlyUnits ||
      current.addon_units !== incoming.addonUnits ||
      (incoming.currentPeriodStart !== undefined &&
        current.period_start !== incoming.currentPeriodStart) ||
      (incoming.currentPeriodEnd !== undefined && current.period_end !== incoming.currentPeriodEnd)
    );
  }

  async fetch(request: Request): Promise<Response> {
    this.ensureTables();

    const url = new URL(request.url);

    if (url.pathname === '/check' && request.method === 'POST') {
      const body: CheckRequest = await request.json();
      const { count, subscriptionConfig, orgId } = body;

      let config = this.getConfig();

      if (!config) {
        this.seedConfig(subscriptionConfig, orgId);
        config = this.requireConfig();
      } else {
        if (this.configChanged(config, subscriptionConfig)) {
          const prevPeriodStart = config.period_start;
          this.updateConfig(subscriptionConfig);
          config = this.requireConfig();

          if (config.period_start !== prevPeriodStart) {
            // New billing period arrived from Stripe sync.
            const counters = this.getCounters();
            this.ctx.storage.sql.exec(
              'UPDATE counters SET subscription_units_used = 0, addon_baseline = ?, last_pushed_subscription = 0, last_pushed_addon = 0 WHERE id = 1',
              counters.addon_units_used,
            );
          }
        }

        await this.handlePeriodRollover();
        config = this.requireConfig();
      }

      const counters = this.getCounters();

      // Fix #2: Check subscription and addon pools independently
      const subscriptionRemaining = config.monthly_units - counters.subscription_units_used;
      const addonRemaining = config.addon_units - counters.addon_units_used;
      const totalRemaining = Math.max(0, subscriptionRemaining) + Math.max(0, addonRemaining);

      if (count > totalRemaining) {
        return Response.json({ allowed: false, periodEnd: config.period_end });
      }

      // Decrement subscription units first, then addon
      if (count <= subscriptionRemaining) {
        this.ctx.storage.sql.exec(
          'UPDATE counters SET subscription_units_used = subscription_units_used + ? WHERE id = 1',
          count,
        );
      } else {
        const addonCount = count - Math.max(0, subscriptionRemaining);
        this.ctx.storage.sql.exec(
          'UPDATE counters SET subscription_units_used = ?, addon_units_used = addon_units_used + ? WHERE id = 1',
          config.monthly_units,
          addonCount,
        );
      }

      // Schedule alarm for Convex push if not already scheduled
      const currentAlarm = await this.ctx.storage.getAlarm();
      if (!currentAlarm) {
        await this.ctx.storage.setAlarm(Date.now() + 60_000);
      }

      return Response.json({ allowed: true });
    }

    return new Response('Not found', { status: 404 });
  }

  async alarm() {
    this.ensureTables();

    const config = this.getConfig();
    if (!config) {
      throw new Error('UsageTracker alarm: no config row found');
    }

    const counters = this.getCounters();

    if (
      counters.subscription_units_used !== counters.last_pushed_subscription ||
      counters.addon_units_used !== counters.last_pushed_addon
    ) {
      const traceContext = this.createTraceContext(
        config.org_id,
        config.period_start,
        config.period_end,
      );
      const logger = this.createUsageLogger(traceContext);
      try {
        await this.pushToConvex(
          config.org_id,
          config.period_start,
          config.period_end,
          logger,
          traceContext,
        );
      } catch (e) {
        logger.error('proxy.usage_alarm_push_failed', e);
        await this.ctx.storage.setAlarm(Date.now() + 60_000);
        return;
      } finally {
        await logger.flush();
      }

      // Fix #1: Re-read counters after push to avoid marking unpushed increments as synced
      const freshCounters = this.getCounters();
      this.ctx.storage.sql.exec(
        'UPDATE counters SET last_pushed_subscription = ?, last_pushed_addon = ? WHERE id = 1',
        freshCounters.subscription_units_used,
        freshCounters.addon_units_used,
      );
    }
  }

  private async pushToConvex(
    orgId: string,
    periodStart: number,
    periodEnd: number,
    logger: Logger,
    traceContext: TraceContext,
  ) {
    const counters = this.getCounters();

    const url = `${this.env.CONVEX_SITE_URL}/usage/record`;

    const response = await fetch(
      url,
      buildUsageSyncRequestInit(this.env.USAGE_SYNC_SECRET, {
        orgId,
        periodStart,
        periodEnd,
        subscriptionUnitsUsed: counters.subscription_units_used,
        addonUnitsUsed: counters.addon_units_used - counters.addon_baseline,
        traceContext,
      }),
    );

    if (!response.ok) {
      const body = await response.text();
      logger.error('proxy.usage_sync_failed', undefined, {
        status: response.status,
        body,
      });
      throw new Error(`pushToConvex failed: ${response.status} ${response.statusText}`);
    }

    logger.info('proxy.usage_synced', {
      subscriptionUnitsUsed: counters.subscription_units_used,
      addonUnitsUsed: counters.addon_units_used - counters.addon_baseline,
      periodStart,
      periodEnd,
    });
  }
}
