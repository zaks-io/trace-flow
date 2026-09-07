import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueryCtx } from '../_generated/server';

const splitchMocks = vi.hoisted(() => ({
  peekDetails: vi.fn(),
}));

vi.mock('@splitch/convex', () => ({
  Splitch: class {
    peekDetails(...args: unknown[]) {
      return splitchMocks.peekDetails(...args);
    }
  },
}));

import {
  PRO_SUBSCRIPTION_FLAG,
  proSubscriptionEnabled,
  proSubscriptionEnabledInternal,
} from '../integrations/splitch';

type QueryHandler<Args> = (ctx: QueryCtx, args: Args) => Promise<boolean>;

const publicHandler = (
  proSubscriptionEnabled as unknown as { _handler: QueryHandler<Record<string, never>> }
)._handler;
const internalHandler = (
  proSubscriptionEnabledInternal as unknown as {
    _handler: QueryHandler<{
      tokenIdentifier: string;
      email?: string;
      name?: string;
      tier?: 'hobby' | 'pro';
    }>;
  }
)._handler;

function makeQueryCtx(
  options: {
    authenticated?: boolean;
    tier?: 'hobby' | 'pro';
  } = {},
): QueryCtx {
  const authenticated = options.authenticated ?? true;
  const user = {
    tokenIdentifier: 'auth0|user-123',
    email: 'user@example.com',
    name: 'Test User',
    orgId: 'org-123',
  };
  const subscription = options.tier ? { tier: options.tier } : null;

  return {
    auth: {
      getUserIdentity: vi.fn().mockResolvedValue(
        authenticated
          ? {
              tokenIdentifier: user.tokenIdentifier,
              email: user.email,
              name: user.name,
            }
          : null,
      ),
    },
    db: {
      query: vi.fn((table: string) => {
        const result = table === 'users' ? user : subscription;
        const query = {
          withIndex: vi.fn().mockReturnThis(),
          first: vi.fn().mockResolvedValue(result),
        };
        return query;
      }),
    },
  } as unknown as QueryCtx;
}

describe('Splitch Pro subscription gate', () => {
  beforeEach(() => {
    splitchMocks.peekDetails.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the enabled boolean for an authenticated user', async () => {
    splitchMocks.peekDetails.mockResolvedValue({
      value: true,
      variantName: 'on',
      reason: 'TARGETING_MATCH',
    });
    const ctx = makeQueryCtx({ tier: 'hobby' });

    await expect(publicHandler(ctx, {})).resolves.toBe(true);
    expect(splitchMocks.peekDetails).toHaveBeenCalledWith(
      ctx,
      PRO_SUBSCRIPTION_FLAG,
      {
        targetingKey: 'auth0|user-123',
        attributes: {
          email: 'user@example.com',
          name: 'Test User',
          tier: 'hobby',
        },
      },
      false,
    );
  });

  it('returns false when the flag is disabled', async () => {
    splitchMocks.peekDetails.mockResolvedValue({
      value: false,
      variantName: 'off',
      reason: 'DISABLED',
    });

    await expect(publicHandler(makeQueryCtx(), {})).resolves.toBe(false);
  });

  it('fails closed and logs resolution errors', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    splitchMocks.peekDetails.mockResolvedValue({
      value: false,
      variantName: null,
      reason: 'ERROR',
      errorCode: 'FLAG_NOT_FOUND',
      errorMessage: 'Flag not found',
    });

    await expect(publicHandler(makeQueryCtx(), {})).resolves.toBe(false);
    expect(error).toHaveBeenCalledWith('convex.splitch_flag_resolution_failed', {
      flagKey: PRO_SUBSCRIPTION_FLAG,
      reason: 'ERROR',
      errorCode: 'FLAG_NOT_FOUND',
      errorMessage: 'Flag not found',
    });
  });

  it('fails closed and logs when local resolution throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    splitchMocks.peekDetails.mockRejectedValue(new Error('Component is not ready'));

    await expect(publicHandler(makeQueryCtx(), {})).resolves.toBe(false);
    expect(error).toHaveBeenCalledWith('convex.splitch_flag_resolution_threw', {
      flagKey: PRO_SUBSCRIPTION_FLAG,
      error: 'Component is not ready',
    });
  });

  it('rejects unauthenticated public reads before evaluation', async () => {
    await expect(publicHandler(makeQueryCtx({ authenticated: false }), {})).rejects.toThrow(
      'Authentication required',
    );
    expect(splitchMocks.peekDetails).not.toHaveBeenCalled();
  });

  it('uses the caller-supplied server identity for checkout evaluation', async () => {
    splitchMocks.peekDetails.mockResolvedValue({
      value: true,
      variantName: 'on',
      reason: 'TARGETING_MATCH',
    });
    const ctx = makeQueryCtx();

    await expect(
      internalHandler(ctx, {
        tokenIdentifier: 'auth0|checkout-owner',
        email: 'owner@example.com',
        name: 'Owner',
        tier: 'hobby',
      }),
    ).resolves.toBe(true);
    expect(splitchMocks.peekDetails).toHaveBeenCalledWith(
      ctx,
      PRO_SUBSCRIPTION_FLAG,
      {
        targetingKey: 'auth0|checkout-owner',
        attributes: {
          email: 'owner@example.com',
          name: 'Owner',
          tier: 'hobby',
        },
      },
      false,
    );
  });
});
