import { describe, expect, it } from 'vitest';
import {
  normalizeAlertScope,
  normalizeChannelConfig,
  validateAlertCondition,
  isOrgOwner,
} from '../costAlerts';
import {
  buildApiKeyParam,
  buildCostAlertPipeParams,
  resolveScopedApiKeys,
  shouldNotify,
} from '../integrations/costAlerts';
import {
  assertCostAlertWebhookDeliveryTarget,
  createPinnedLookup,
  sendCostAlertWebhookNotification,
} from '../integrations/costAlertWebhookDelivery';

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

  it('rejects webhook URLs that target private, loopback, and link-local addresses', async () => {
    await expect(assertCostAlertWebhookDeliveryTarget('http://127.0.0.1/hook')).rejects.toThrow(
      'private or link-local',
    );
    await expect(assertCostAlertWebhookDeliveryTarget('http://10.0.0.1/hook')).rejects.toThrow(
      'private or link-local',
    );
    await expect(assertCostAlertWebhookDeliveryTarget('http://172.16.0.1/hook')).rejects.toThrow(
      'private or link-local',
    );
    await expect(assertCostAlertWebhookDeliveryTarget('http://192.168.1.10/hook')).rejects.toThrow(
      'private or link-local',
    );
    await expect(
      assertCostAlertWebhookDeliveryTarget('http://169.254.169.254/latest/meta-data'),
    ).rejects.toThrow('private or link-local');
    await expect(assertCostAlertWebhookDeliveryTarget('http://[::1]/hook')).rejects.toThrow(
      'private or link-local',
    );
    await expect(assertCostAlertWebhookDeliveryTarget('http://[fe80::1]/hook')).rejects.toThrow(
      'private or link-local',
    );
    await expect(
      assertCostAlertWebhookDeliveryTarget('http://metadata.google.internal/computeMetadata/v1'),
    ).rejects.toThrow('host is not allowed');
    await expect(assertCostAlertWebhookDeliveryTarget('http://localhost/hook')).rejects.toThrow(
      'host is not allowed',
    );
  });

  it('rejects webhook hostnames that resolve to private addresses before fetch', async () => {
    let fetched = false;

    await expect(
      sendCostAlertWebhookNotification(
        {
          url: 'https://receiver.example/hook',
        },
        { ok: true },
        'delivery-1',
        {
          resolveAddresses: async () => ['10.0.0.5'],
          sendRequest: async () => {
            fetched = true;
            return { ok: true, status: 204, body: '' };
          },
        },
      ),
    ).rejects.toThrow('cannot resolve to private');

    expect(fetched).toBe(false);
  });

  it('delivers to allowed public HTTPS endpoints through the pinned request sender', async () => {
    const calls: {
      url: string;
      address: string;
      family: 4 | 6;
      body: string;
      headers: Headers;
    }[] = [];

    await sendCostAlertWebhookNotification(
      {
        url: 'https://receiver.example/hook',
        secret: 'secret',
        headers: [{ key: 'X-Receiver', value: 'cost-alerts' }],
      },
      { ok: true },
      'delivery-1',
      {
        resolveAddresses: async () => ['93.184.216.34'],
        sendRequest: async (request) => {
          calls.push({
            url: request.url.toString(),
            address: request.address,
            family: request.family,
            body: request.body,
            headers: request.headers,
          });
          return { ok: true, status: 204, body: '' };
        },
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://receiver.example/hook');
    expect(calls[0]?.address).toBe('93.184.216.34');
    expect(calls[0]?.family).toBe(4);
    expect(calls[0]?.body).toBe('{"ok":true}');

    const headers = calls[0]!.headers;
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('Idempotency-Key')).toBe('delivery-1');
    expect(headers.get('X-Receiver')).toBe('cost-alerts');
    expect(headers.get('X-Trace-Flow-Signature')).toBeTruthy();
  });

  it('rejects redirect responses instead of following them', async () => {
    await expect(
      sendCostAlertWebhookNotification(
        {
          url: 'https://receiver.example/hook',
        },
        { ok: true },
        'delivery-1',
        {
          resolveAddresses: async () => ['93.184.216.34'],
          sendRequest: async () => ({ ok: false, status: 302, body: 'Moved' }),
        },
      ),
    ).rejects.toThrow('Webhook delivery failed: 302 Moved');
  });

  it('pins delivery to the validated address to prevent DNS rebinding during send', async () => {
    const requests: { address: string; family: 4 | 6 }[] = [];
    let resolveCount = 0;

    await sendCostAlertWebhookNotification(
      {
        url: 'https://receiver.example/hook',
      },
      { ok: true },
      'delivery-1',
      {
        resolveAddresses: async () => {
          resolveCount += 1;
          return resolveCount === 1 ? ['93.184.216.34'] : ['10.0.0.5'];
        },
        sendRequest: async (request) => {
          requests.push({ address: request.address, family: request.family });
          return { ok: true, status: 204, body: '' };
        },
      },
    );

    expect(resolveCount).toBe(1);
    expect(requests).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('uses the pinned lookup result for outbound connection creation', () => {
    const lookup = createPinnedLookup('93.184.216.34', 4);

    lookup('receiver.example', {}, (error, address, family) => {
      expect(error).toBe(null);
      expect(address).toBe('93.184.216.34');
      expect(family).toBe(4);
    });

    lookup('receiver.example', { all: true }, (error, addresses) => {
      expect(error).toBe(null);
      expect(addresses).toEqual([{ address: '93.184.216.34', family: 4 }]);
    });
  });

  it('rejects custom webhook headers that can override delivery routing or auth', () => {
    expect(() =>
      normalizeChannelConfig({
        type: 'webhook',
        url: 'https://example.com/hook',
        headers: [{ key: 'Host', value: 'internal.service' }],
      }),
    ).toThrow('Webhook header "Host" is not allowed');

    expect(() =>
      normalizeChannelConfig({
        type: 'webhook',
        url: 'https://example.com/hook',
        headers: [{ key: 'Authorization', value: 'Bearer attacker' }],
      }),
    ).toThrow('Webhook header "Authorization" is not allowed');
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

  it('normalizes optional cost alert dimension scope', () => {
    expect(
      normalizeAlertScope({
        provider: ' openai ',
        model: ' gpt-4o ',
        baggageOperation: ' checkout ',
        baggageUserId: ' user_123 ',
      }),
    ).toEqual({
      provider: 'openai',
      model: 'gpt-4o',
      baggageOperation: 'checkout',
      baggageUserId: 'user_123',
    });

    expect(
      normalizeAlertScope({
        provider: ' ',
        model: '',
      }),
    ).toBeUndefined();

    expect(() => normalizeAlertScope({ provider: 'x'.repeat(201) })).toThrow(
      'Scope filter values must be 200 characters or fewer',
    );
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

  it('builds alert pipe params with API-key and dimension narrowing filters', () => {
    expect(
      buildCostAlertPipeParams(
        {
          selectedKeys: ['key-1'],
          retentionDays: 30,
          scope: {
            provider: 'anthropic',
            model: 'claude-sonnet-4',
            baggageOperation: 'review',
            baggageUserId: 'user_456',
          },
        },
        { baseline_hours: 24, api_keys: 'attacker-supplied' },
      ),
    ).toEqual({
      api_keys: 'key-1',
      retention_days: 30,
      provider: 'anthropic',
      model: 'claude-sonnet-4',
      baggage_operation: 'review',
      baggage_user_id: 'user_456',
      baseline_hours: 24,
    });
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
