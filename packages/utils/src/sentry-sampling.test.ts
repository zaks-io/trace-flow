import { describe, expect, it } from 'vitest';
import { sentryTracesSampleRate } from './sentry-sampling';

describe('sentryTracesSampleRate', () => {
  it('samples a tenth of new production traces', () => {
    expect(sentryTracesSampleRate('prod')).toBe(0.1);
  });

  it.each(['development', 'preview', 'test', 'production', undefined])(
    'keeps every trace outside the prod environment (%s)',
    (environment) => {
      expect(sentryTracesSampleRate(environment)).toBe(1);
    },
  );
});
