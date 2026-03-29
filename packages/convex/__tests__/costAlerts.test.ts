import { describe, expect, it } from 'vitest';
import { normalizeChannelConfig, validateAlertCondition, isOrgOwner } from '../costAlerts';
import { buildApiKeyParam, resolveScopedApiKeys, shouldNotify } from '../integrations/costAlerts';

describe('cost alert helpers', () => {
  it('recognizes org owners', () => {
    expect(isOrgOwner('user_1' as never, 'user_1' as never)).toBe(true);
    expect(isOrgOwner('user_1' as never, 'user_2' as never)).toBe(false);
  });

  it('normalizes email recipients and webhook headers', () => {
    expect(
      normalizeChannelConfig({
        type: 'email',
        recipients: ['Ops@example.com', 'ops@example.com', ' finance@example.com '],
      }),
    ).toEqual({
      type: 'email',
      recipients: ['ops@example.com', 'finance@example.com'],
    });

    expect(
      normalizeChannelConfig({
        type: 'webhook',
        url: 'https://example.com/hook',
        secret: 'secret',
        headers: [
          { key: ' X-Test ', value: ' hello ' },
          { key: '', value: 'ignored' },
        ],
      }),
    ).toEqual({
      type: 'webhook',
      url: 'https://example.com/hook',
      secret: 'secret',
      headers: [{ key: 'X-Test', value: 'hello' }],
    });
  });

  it('validates supported alert conditions', () => {
    expect(() =>
      validateAlertCondition({
        type: 'absolute_spend_threshold',
        window: 'last_hour',
        thresholdUsd: 25,
      }),
    ).not.toThrow();

    expect(() =>
      validateAlertCondition({
        type: 'hourly_spend_spike',
        baselineHours: 2,
        multiplier: 2,
        minCurrentHourUsd: 10,
        minIncreaseUsd: 5,
      }),
    ).toThrow('Spike baseline must be between 4 and 168 hours');
  });

  it('scopes API keys correctly', () => {
    expect(buildApiKeyParam([])).toBe('__NO_KEYS__');
    expect(
      resolveScopedApiKeys({ apiKeyIds: ['api_2'] }, [
        { _id: 'api_1', key: 'key-1' },
        { _id: 'api_2', key: 'key-2' },
      ]),
    ).toEqual(['key-2']);
    expect(
      resolveScopedApiKeys({}, [
        { _id: 'api_1', key: 'key-1' },
        { _id: 'api_2', key: 'key-2' },
      ]),
    ).toEqual(['key-1', 'key-2']);
  });

  it('deduplicates breach notifications using cooldown', () => {
    const initial = shouldNotify(
      { cooldownMinutes: 60, notifyOnRecovery: true },
      undefined,
      true,
      1_000,
    );
    expect(initial.notify).toBe(true);
    expect(initial.eventType).toBe('triggered');

    const cooldownBlocked = shouldNotify(
      { cooldownMinutes: 60, notifyOnRecovery: true },
      {
        active: true,
        lastNotificationAt: 1_000,
        lastTriggeredAt: 1_000,
      },
      true,
      10_000,
    );
    expect(cooldownBlocked.notify).toBe(false);

    const recovered = shouldNotify(
      { cooldownMinutes: 60, notifyOnRecovery: true },
      {
        active: true,
        lastNotificationAt: 1_000,
        lastTriggeredAt: 1_000,
      },
      false,
      20_000,
    );
    expect(recovered.notify).toBe(true);
    expect(recovered.eventType).toBe('recovered');
  });

  it('updates lastTriggeredAt on every trigger', () => {
    const first = shouldNotify(
      { cooldownMinutes: 60, notifyOnRecovery: false },
      undefined,
      true,
      1_000,
    );
    expect(first.lastTriggeredAt).toBe(1_000);

    // Re-trigger after cooldown — lastTriggeredAt should update to now
    const reTrigger = shouldNotify(
      { cooldownMinutes: 60, notifyOnRecovery: false },
      {
        active: true,
        lastNotificationAt: 1_000,
        lastTriggeredAt: 1_000,
      },
      true,
      4_000_000,
    );
    expect(reTrigger.lastTriggeredAt).toBe(4_000_000);
    expect(reTrigger.notify).toBe(true);
  });

  it('suppresses re-notifications when suppressRenotify is set', () => {
    // First trigger should still notify
    const first = shouldNotify(
      { cooldownMinutes: 60, notifyOnRecovery: true },
      undefined,
      true,
      1_000,
      { suppressRenotify: true },
    );
    expect(first.notify).toBe(true);
    expect(first.eventType).toBe('triggered');

    // After cooldown expires, should NOT re-notify with suppressRenotify
    const reNotify = shouldNotify(
      { cooldownMinutes: 60, notifyOnRecovery: true },
      {
        active: true,
        lastNotificationAt: 1_000,
        lastTriggeredAt: 1_000,
      },
      true,
      4_000_000,
      { suppressRenotify: true },
    );
    expect(reNotify.notify).toBe(false);
    expect(reNotify.active).toBe(true);

    // Without suppressRenotify, same scenario should re-notify
    const normalReNotify = shouldNotify(
      { cooldownMinutes: 60, notifyOnRecovery: true },
      {
        active: true,
        lastNotificationAt: 1_000,
        lastTriggeredAt: 1_000,
      },
      true,
      4_000_000,
    );
    expect(normalReNotify.notify).toBe(true);
  });

  it('fires with zero cooldown on every evaluation', () => {
    const first = shouldNotify(
      { cooldownMinutes: 0, notifyOnRecovery: false },
      undefined,
      true,
      1_000,
    );
    expect(first.notify).toBe(true);

    const second = shouldNotify(
      { cooldownMinutes: 0, notifyOnRecovery: false },
      {
        active: true,
        lastNotificationAt: 1_000,
        lastTriggeredAt: 1_000,
      },
      true,
      2_000,
    );
    expect(second.notify).toBe(true);
  });

  it('does not notify on recovery when notifyOnRecovery is false', () => {
    const result = shouldNotify(
      { cooldownMinutes: 60, notifyOnRecovery: false },
      {
        active: true,
        lastNotificationAt: 1_000,
        lastTriggeredAt: 1_000,
      },
      false,
      20_000,
    );
    expect(result.notify).toBe(false);
    expect(result.eventType).toBe(null);
    expect(result.active).toBe(false);
    expect(result.lastRecoveredAt).toBe(20_000);
  });
});
