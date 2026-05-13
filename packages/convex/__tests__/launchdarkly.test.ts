import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('isProSubscriptionEnabled', () => {
  const ORIGINAL_ENV = process.env.LAUNCHDARKLY_SDK_KEY;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.LAUNCHDARKLY_SDK_KEY;
    else process.env.LAUNCHDARKLY_SDK_KEY = ORIGINAL_ENV;
  });

  it('returns false when LAUNCHDARKLY_SDK_KEY is unset (fails closed)', async () => {
    delete process.env.LAUNCHDARKLY_SDK_KEY;
    const { isProSubscriptionEnabled } = await import('../integrations/launchdarkly');
    const ctx = {} as any;
    const result = await isProSubscriptionEnabled(ctx, {
      tokenIdentifier: 'token|123',
      email: 'test@example.com',
    });
    expect(result).toBe(false);
  });

  it('returns false and swallows SDK errors (fails closed)', async () => {
    process.env.LAUNCHDARKLY_SDK_KEY = 'sdk-fake-test-key';
    vi.doMock('@convex-dev/launchdarkly', () => ({
      LaunchDarkly: class {
        sdk() {
          throw new Error('boom');
        }
      },
    }));
    const { isProSubscriptionEnabled } = await import('../integrations/launchdarkly');
    const ctx = {} as any;
    const result = await isProSubscriptionEnabled(ctx, { tokenIdentifier: 'token|123' });
    expect(result).toBe(false);
    vi.doUnmock('@convex-dev/launchdarkly');
  });

  it('returns the SDK boolVariation result when configured', async () => {
    process.env.LAUNCHDARKLY_SDK_KEY = 'sdk-fake-test-key';
    const boolVariation = vi.fn().mockResolvedValue(true);
    vi.doMock('@convex-dev/launchdarkly', () => ({
      LaunchDarkly: class {
        sdk() {
          return { boolVariation };
        }
      },
    }));
    const { isProSubscriptionEnabled, PRO_SUBSCRIPTION_FLAG } =
      await import('../integrations/launchdarkly');
    const ctx = {} as any;
    const result = await isProSubscriptionEnabled(ctx, {
      tokenIdentifier: 'token|123',
      email: 'a@b.com',
    });
    expect(result).toBe(true);
    expect(boolVariation).toHaveBeenCalledWith(
      PRO_SUBSCRIPTION_FLAG,
      expect.objectContaining({
        kind: 'user',
        key: 'token|123',
        email: 'a@b.com',
      }),
      false,
    );
    vi.doUnmock('@convex-dev/launchdarkly');
  });

  it('passes false-returning variation through', async () => {
    process.env.LAUNCHDARKLY_SDK_KEY = 'sdk-fake-test-key';
    vi.doMock('@convex-dev/launchdarkly', () => ({
      LaunchDarkly: class {
        sdk() {
          return { boolVariation: vi.fn().mockResolvedValue(false) };
        }
      },
    }));
    const { isProSubscriptionEnabled } = await import('../integrations/launchdarkly');
    const ctx = {} as any;
    const result = await isProSubscriptionEnabled(ctx, { tokenIdentifier: 'token|123' });
    expect(result).toBe(false);
    vi.doUnmock('@convex-dev/launchdarkly');
  });
});
