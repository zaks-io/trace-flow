import { describe, expect, it } from 'vitest';
import {
  buildAlertInput,
  buildChannelConfigInput,
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
        channelIds: ['channel_1'],
      }),
    ).toEqual({
      name: 'Spike',
      severity: 'warning',
      channelIds: ['channel_1'],
      cooldownMinutes: 30,
      notifyOnRecovery: true,
      apiKeyIds: ['api_1'],
      condition: {
        type: 'hourly_spend_spike',
        baselineHours: 48,
        multiplier: 2.5,
        minCurrentHourUsd: 15,
        minIncreaseUsd: 10,
      },
    });
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
