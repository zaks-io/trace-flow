import type { SubscriptionKVData } from '@trace-flow/types';

export interface UsageSnapshot {
  orgId: string;
  periodStart: number;
  periodEnd: number;
  subscriptionUnitsUsed: number;
  addonUnitsUsed: number;
}

interface ConfigRow {
  org_id: string;
  tier: string;
  monthly_units: number;
  addon_units: number;
  period_start: number;
  period_end: number;
  period_estimated: number;
}

interface CounterRow {
  subscription_units_used: number;
  addon_units_used: number;
  addon_baseline: number;
  last_pushed_subscription: number;
  last_pushed_addon: number;
}

const MAX_PENDING_PERIODS = 128;
const LEGACY_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

export class UsagePeriod {
  constructor(private readonly storage: DurableObjectStorage) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS config (
      id INTEGER PRIMARY KEY DEFAULT 1, org_id TEXT NOT NULL, tier TEXT NOT NULL,
      monthly_units INTEGER NOT NULL, addon_units INTEGER NOT NULL,
      period_start INTEGER NOT NULL, period_end INTEGER NOT NULL,
      period_estimated INTEGER NOT NULL DEFAULT 0
    )`);
    if (
      !storage.sql
        .exec<{ name: string }>('PRAGMA table_info(config)')
        .toArray()
        .some((column) => column.name === 'period_estimated')
    ) {
      storage.sql.exec('ALTER TABLE config ADD COLUMN period_estimated INTEGER NOT NULL DEFAULT 0');
    }
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS counters (
      id INTEGER PRIMARY KEY DEFAULT 1, subscription_units_used INTEGER NOT NULL DEFAULT 0,
      addon_units_used INTEGER NOT NULL DEFAULT 0, addon_baseline INTEGER NOT NULL DEFAULT 0,
      last_pushed_subscription INTEGER NOT NULL DEFAULT 0, last_pushed_addon INTEGER NOT NULL DEFAULT 0
    )`);
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS usage_outbox (
      period_start INTEGER PRIMARY KEY, period_end INTEGER NOT NULL,
      subscription_units INTEGER NOT NULL, addon_units INTEGER NOT NULL
    )`);
  }

  private config(): ConfigRow | undefined {
    return this.storage.sql
      .exec<Pick<ConfigRow, keyof ConfigRow>>('SELECT * FROM config WHERE id = 1')
      .toArray()[0];
  }

  private counters(): CounterRow {
    const row = this.storage.sql
      .exec<Pick<CounterRow, keyof CounterRow>>('SELECT * FROM counters WHERE id = 1')
      .toArray()[0];
    if (!row) throw new Error('Usage counters missing');
    return row;
  }

  private stage(config: ConfigRow, counters: CounterRow, force = false): boolean {
    if (
      !force &&
      counters.subscription_units_used === counters.last_pushed_subscription &&
      counters.addon_units_used === counters.last_pushed_addon
    ) {
      return true;
    }
    const pending = this.storage.sql
      .exec<{ count: number }>('SELECT COUNT(*) AS count FROM usage_outbox')
      .one().count;
    const exists = this.storage.sql
      .exec('SELECT period_start FROM usage_outbox WHERE period_start = ?', config.period_start)
      .toArray().length;
    if (!exists && pending >= MAX_PENDING_PERIODS) {
      return false;
    }
    this.storage.sql.exec(
      `INSERT INTO usage_outbox VALUES (?, ?, ?, ?)
       ON CONFLICT(period_start) DO UPDATE SET
         period_end = excluded.period_end,
         subscription_units = MAX(subscription_units, excluded.subscription_units),
         addon_units = MAX(addon_units, excluded.addon_units)`,
      config.period_start,
      config.period_end,
      counters.subscription_units_used,
      counters.addon_units_used - counters.addon_baseline,
    );
    return true;
  }

  private movePeriod(config: ConfigRow, start: number, end: number, estimated = false) {
    const counters = this.counters();
    if (!this.stage(config, counters)) throw new Error('Usage synchronization backlog is full');
    this.storage.sql.exec(
      'UPDATE config SET period_start = ?, period_end = ?, period_estimated = ? WHERE id = 1',
      start,
      end,
      estimated ? 1 : 0,
    );
    this.storage.sql.exec(
      `UPDATE counters SET subscription_units_used = 0, addon_baseline = ?,
       last_pushed_subscription = 0, last_pushed_addon = ? WHERE id = 1`,
      counters.addon_units_used,
      counters.addon_units_used,
    );
  }

  check(orgId: string, incoming: SubscriptionKVData, count: number, now: number) {
    return this.storage.transactionSync(() => {
      let config = this.config();
      const start = incoming.currentPeriodStart ?? config?.period_start ?? now;
      const end = incoming.currentPeriodEnd ?? config?.period_end ?? start + LEGACY_PERIOD_MS;
      for (const value of [count, incoming.monthlyUnits, incoming.addonUnits, start, end]) {
        if (!Number.isSafeInteger(value) || value < 0)
          throw new Error('Invalid usage configuration');
      }
      if (!orgId || end <= start) throw new Error('Invalid usage period or organization');
      const authoritative =
        incoming.currentPeriodStart !== undefined && incoming.currentPeriodEnd !== undefined;
      if (!config) {
        this.storage.sql.exec(
          'INSERT INTO config (id, org_id, tier, monthly_units, addon_units, period_start, period_end, period_estimated) VALUES (1, ?, ?, ?, ?, ?, ?, ?)',
          orgId,
          incoming.tier,
          incoming.monthlyUnits,
          incoming.addonUnits,
          start,
          end,
          authoritative ? 0 : 1,
        );
        this.storage.sql.exec('INSERT INTO counters VALUES (1, 0, 0, 0, 0, 0)');
      } else {
        if (config.org_id !== orgId) throw new Error('Usage organization mismatch');
        if (
          config.period_estimated &&
          authoritative &&
          start <= now &&
          now < end &&
          start > config.period_start - (config.period_end - config.period_start) &&
          start !== config.period_start
        ) {
          // Correct the current estimate without resetting its counters. Reopening an older
          // period could lose usage whose snapshot has already been confirmed and removed.
          this.storage.sql.exec(
            'DELETE FROM usage_outbox WHERE period_start = ?',
            config.period_start,
          );
          this.storage.sql.exec(
            'UPDATE config SET period_start = ?, period_end = ?, period_estimated = 0 WHERE id = 1',
            start,
            end,
          );
          this.storage.sql.exec(
            'UPDATE counters SET last_pushed_subscription = 0, last_pushed_addon = addon_baseline WHERE id = 1',
          );
        } else if (start > config.period_start) this.movePeriod(config, start, end);
        else if (start === config.period_start && end !== config.period_end) {
          this.storage.sql.exec('UPDATE config SET period_end = ? WHERE id = 1', end);
          if (!this.stage({ ...config, period_end: end }, this.counters(), true)) {
            throw new Error('Usage synchronization backlog is full');
          }
        }
        if (authoritative && start === config.period_start && start <= now && now < end) {
          this.storage.sql.exec('UPDATE config SET period_estimated = 0 WHERE id = 1');
        }
        // KV can lag a locally rolled period; entitlement updates still apply.
        this.storage.sql.exec(
          'UPDATE config SET tier = ?, monthly_units = ?, addon_units = ? WHERE id = 1',
          incoming.tier,
          incoming.monthlyUnits,
          incoming.addonUnits,
        );
      }
      config = this.config()!;
      if (now >= config.period_end) {
        const duration = config.period_end - config.period_start;
        const elapsed = Math.floor((now - config.period_start) / duration);
        const nextStart = config.period_start + elapsed * duration;
        const nextEnd = nextStart + duration;
        if (!Number.isSafeInteger(nextEnd)) throw new Error('Usage period overflow');
        this.movePeriod(config, nextStart, nextEnd, true);
        config = this.config()!;
      }
      const counters = this.counters();
      const subscriptionRemaining = Math.max(
        0,
        config.monthly_units - counters.subscription_units_used,
      );
      const addonRemaining = Math.max(0, config.addon_units - counters.addon_units_used);
      if (count > subscriptionRemaining + addonRemaining) {
        return { allowed: false, periodEnd: config.period_end };
      }
      const subscriptionCount = Math.min(count, subscriptionRemaining);
      this.storage.sql.exec(
        `UPDATE counters SET subscription_units_used = subscription_units_used + ?,
         addon_units_used = addon_units_used + ? WHERE id = 1`,
        subscriptionCount,
        count - subscriptionCount,
      );
      return { allowed: true };
    });
  }

  pending(): UsageSnapshot[] {
    return this.storage.transactionSync(() => {
      const config = this.config();
      if (!config) return [];
      this.stage(config, this.counters());
      return this.storage.sql
        .exec<{
          period_start: number;
          period_end: number;
          subscription_units: number;
          addon_units: number;
        }>('SELECT * FROM usage_outbox ORDER BY period_start LIMIT 16')
        .toArray()
        .map((row) => ({
          orgId: config.org_id,
          periodStart: row.period_start,
          periodEnd: row.period_end,
          subscriptionUnitsUsed: row.subscription_units,
          addonUnitsUsed: row.addon_units,
        }));
    });
  }

  confirm(snapshot: UsageSnapshot) {
    this.storage.transactionSync(() => {
      // A rollover during fetch can stage larger final totals for the same period.
      this.storage.sql.exec(
        `DELETE FROM usage_outbox WHERE period_start = ? AND period_end = ?
         AND subscription_units = ? AND addon_units = ?`,
        snapshot.periodStart,
        snapshot.periodEnd,
        snapshot.subscriptionUnitsUsed,
        snapshot.addonUnitsUsed,
      );
      const config = this.config();
      if (
        config?.period_start === snapshot.periodStart &&
        config.period_end === snapshot.periodEnd
      ) {
        const counters = this.counters();
        this.storage.sql.exec(
          'UPDATE counters SET last_pushed_subscription = ?, last_pushed_addon = ? WHERE id = 1',
          snapshot.subscriptionUnitsUsed,
          counters.addon_baseline + snapshot.addonUnitsUsed,
        );
      }
    });
  }

  needsSync(): boolean {
    const config = this.config();
    if (!config) return false;
    const counters = this.counters();
    return (
      counters.subscription_units_used !== counters.last_pushed_subscription ||
      counters.addon_units_used !== counters.last_pushed_addon ||
      this.storage.sql.exec('SELECT period_start FROM usage_outbox LIMIT 1').toArray().length > 0
    );
  }
}
