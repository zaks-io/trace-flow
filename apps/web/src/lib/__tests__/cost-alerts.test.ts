import { describe, expect, it } from 'vitest';
import {
  alertFormFromRule,
  buildAlertInput,
  buildAlertScopeInput,
  buildChannelConfigInput,
  formatScope,
  formatCondition,
  parseRecipients,
  sanitizeHeaderRows,
} from '../cost-alerts';

describe('cost alert helpers', () => {
  it('parses email recipients from mixed separators', () => {
    expect(parseRecipients('Ops@example.com, finance@example.com\nops@example.com')).toEqual([
      'ops@example.com',
      'finance@example.com',
    ]);
  });

  it('sanitizes webhook header rows', () => {
    expect(
      sanitizeHeaderRows([
        { key: ' X-Test ', value: ' hello ' },
        { key: '', value: 'ignored' },
      ]),
    ).toEqual([{ key: 'X-Test', value: 'hello' }]);
  });

  it('builds email channel config', () => {
    expect(
      buildChannelConfigInput({
        name: 'Ops',
        type: 'email',
        recipientsText: 'ops@example.com, finance@example.com',
        webhookUrl: '',
        webhookSecret: '',
        webhookHeaders: [],
      }),
    ).toEqual({
      type: 'email',
      recipients: ['ops@example.com', 'finance@example.com'],
    });
  });

  it('builds spike alert input', () => {
    expect(
      buildAlertInput({
        name: 'Spike',
        severity: 'warning',
        conditionType: 'hourly_spend_spike',
        window: 'last_24_hours',
        thresholdUsd: '',
        baselineHours: '48',
        multiplier: '2.5',
        minCurrentHourUsd: '15',
        minIncreaseUsd: '10',
        cooldownMinutes: '30',
        notifyOnRecovery: true,
        apiKeyIds: ['api_1'],
        provider: ' anthropic ',
        model: ' claude-sonnet-4 ',
        baggageOperation: ' review ',
        baggageUserId: ' user_123 ',
        channelIds: ['channel_1'],
      }),
    ).toEqual({
      name: 'Spike',
      severity: 'warning',
      channelIds: ['channel_1'],
      cooldownMinutes: 30,
      notifyOnRecovery: true,
      apiKeyIds: ['api_1'],
      scope: {
        provider: 'anthropic',
        model: 'claude-sonnet-4',
        baggageOperation: 'review',
        baggageUserId: 'user_123',
      },
      condition: {
        type: 'hourly_spend_spike',
        baselineHours: 48,
        multiplier: 2.5,
        minCurrentHourUsd: 15,
        minIncreaseUsd: 10,
      },
    });
  });

  it('roundtrips and displays scoped alert filters', () => {
    const rule = {
      _id: 'alert_1',
      name: 'Scoped spend',
      severity: 'warning',
      apiKeyIds: ['api_1'],
      scope: {
        provider: 'openai',
        model: 'gpt-4o',
        baggageOperation: 'checkout',
        baggageUserId: 'user_456',
      },
      channelIds: ['channel_1'],
      cooldownMinutes: 60,
      notifyOnRecovery: true,
      condition: {
        type: 'absolute_spend_threshold',
        window: 'last_24_hours',
        thresholdUsd: 25,
      },
    } as const;

    expect(alertFormFromRule(rule as never)).toMatchObject({
      provider: 'openai',
      model: 'gpt-4o',
      baggageOperation: 'checkout',
      baggageUserId: 'user_456',
      apiKeyIds: ['api_1'],
    });
    expect(
      formatScope(rule as never, [{ _id: 'api_1' as never, name: 'Production', key: 'key-1' }]),
    ).toBe('Production · Provider: openai · Model: gpt-4o · Operation: checkout · User: user_456');
  });

  it('keeps empty scope fields unscoped for saves', () => {
    expect(
      buildAlertScopeInput({
        name: 'Budget',
        severity: 'warning',
        conditionType: 'projected_monthly_over',
        window: 'last_24_hours',
        thresholdUsd: '1000',
        baselineHours: '24',
        multiplier: '2',
        minCurrentHourUsd: '10',
        minIncreaseUsd: '5',
        cooldownMinutes: '60',
        notifyOnRecovery: true,
        apiKeyIds: [],
        provider: ' ',
        model: '',
        baggageOperation: '',
        baggageUserId: '',
        channelIds: ['channel_1'],
      }),
    ).toEqual({});
  });

  it('formats condition summaries for threshold rules', () => {
    expect(
      formatCondition({
        type: 'projected_monthly_over',
        thresholdUsd: 1000,
      }),
    ).toBe('Projected Monthly Over: $1000.00');
  });
});
