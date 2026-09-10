import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionCtx } from '../_generated/server';

const stripeMocks = vi.hoisted(() => ({
  getStripeClient: vi.fn(),
  createCustomer: vi.fn(),
  createCheckoutSession: vi.fn(),
}));

vi.mock('../billing/stripe', () => ({
  appUrl: 'https://trace-flow.example',
  getAddonPriceId: () => 'price_addon',
  getProPriceId: () => 'price_pro',
  getStripeClient: stripeMocks.getStripeClient,
}));

import { createOrgCheckoutSession } from '../billing/subscriptions';

type CreateCheckoutHandler = (
  ctx: ActionCtx,
  args: { successUrl?: string; cancelUrl?: string },
) => Promise<{ url: string | null }>;

const createCheckoutHandler = (
  createOrgCheckoutSession as unknown as { _handler: CreateCheckoutHandler }
)._handler;

const user = {
  _id: 'user-123',
  tokenIdentifier: 'auth0|user-123',
  email: 'owner@example.com',
  name: 'Owner',
  enabled: true,
  orgId: 'org-123',
};

const organization = {
  _id: user.orgId,
  ownerId: user._id,
  name: 'Test organization',
};

function makeActionCtx(proEnabled: boolean): ActionCtx {
  const runQuery = vi
    .fn()
    .mockResolvedValueOnce(user)
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(organization)
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(proEnabled);

  return {
    auth: {
      getUserIdentity: vi.fn().mockResolvedValue({ tokenIdentifier: user.tokenIdentifier }),
    },
    runQuery,
    runMutation: vi.fn().mockResolvedValue(null),
  } as unknown as ActionCtx;
}

describe('createOrgCheckoutSession Pro gate', () => {
  beforeEach(() => {
    stripeMocks.getStripeClient.mockReset();
    stripeMocks.createCustomer.mockReset();
    stripeMocks.createCheckoutSession.mockReset();
    stripeMocks.getStripeClient.mockReturnValue({
      customers: { create: stripeMocks.createCustomer },
      checkout: { sessions: { create: stripeMocks.createCheckoutSession } },
    });
  });

  it('rejects a disabled resolution before calling Stripe', async () => {
    const ctx = makeActionCtx(false);

    await expect(createCheckoutHandler(ctx, {})).rejects.toThrow(
      'Pro subscription is not yet available',
    );
    expect(stripeMocks.getStripeClient).not.toHaveBeenCalled();
    expect(stripeMocks.createCustomer).not.toHaveBeenCalled();
    expect(stripeMocks.createCheckoutSession).not.toHaveBeenCalled();
    expect(ctx.runMutation).not.toHaveBeenCalled();
  });

  it('creates checkout after an enabled resolution', async () => {
    const ctx = makeActionCtx(true);
    stripeMocks.createCustomer.mockResolvedValue({ id: 'cus-123' });
    stripeMocks.createCheckoutSession.mockResolvedValue({
      url: 'https://checkout.example/session',
    });

    await expect(createCheckoutHandler(ctx, {})).resolves.toEqual({
      url: 'https://checkout.example/session',
    });
    expect(stripeMocks.getStripeClient).toHaveBeenCalledOnce();
    expect(stripeMocks.createCustomer).toHaveBeenCalledOnce();
    expect(stripeMocks.createCheckoutSession).toHaveBeenCalledOnce();
    expect(ctx.runMutation).toHaveBeenCalledTimes(2);
  });
});
