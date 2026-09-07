import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../_generated/api';
import schema from '../schema';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('resend', () => ({
  Resend: class {
    emails = { send };
  },
}));
vi.mock('../rateLimits', () => ({ rateLimiter: { limit: vi.fn() } }));

const modules = {
  '../_generated/server.ts': () => import('../_generated/server'),
  '../waitlist.ts': () => import('../waitlist'),
  '../integrations/emails.ts': () => import('../integrations/emails'),
};

async function setup() {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    for (const [token, email, enabled, isAdmin] of [
      ['admin-1', 'admin@example.com', true, true],
      ['admin-2', 'second@example.com', true, true],
      ['duplicate', ' ADMIN@example.com ', true, true],
      ['disabled', 'disabled@example.com', false, true],
      ['member', 'member@example.com', true, false],
    ] as const) {
      await ctx.db.insert('users', { tokenIdentifier: token, email, enabled, isAdmin });
    }
  });
  return t;
}

describe('waitlist admin notifications', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    send.mockReset().mockResolvedValue({ data: { id: 'email-id' }, error: null });
  });
  afterEach(() => vi.useRealTimers());

  it('notifies enabled admins only on first confirmation, never on submission or repeated confirmation', async () => {
    const t = await setup();
    await t.mutation(api.waitlist.joinWaitlist, { email: ' New@example.com ' });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].to).toBe('new@example.com');
    await t.mutation(api.waitlist.joinWaitlist, { email: 'new@example.com' });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(send).toHaveBeenCalledTimes(1);

    const entry = await t.run((ctx) => ctx.db.query('waitlist').first());
    await t.mutation(api.waitlist.confirmEmail, { token: entry!.confirmationToken });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(send).toHaveBeenCalledTimes(3);
    const notifications = send.mock.calls.filter(
      ([message]) => message.subject === 'Confirmed Trace Flow waitlist signup',
    );
    expect(notifications.map(([message]) => message.to)).toEqual([
      'admin@example.com',
      'second@example.com',
    ]);
    for (const [message, options] of notifications) {
      expect(message.text).toContain('new@example.com');
      expect(message.text).toContain('/app/admin/invites');
      expect(options.idempotencyKey).toContain('waitlist-confirmed/');
    }
    expect(send.mock.calls.some(([message]) => message.to === 'new@example.com')).toBe(true);

    await t.mutation(api.waitlist.joinWaitlist, { email: 'new@example.com' });
    await t.mutation(api.waitlist.confirmEmail, { token: entry!.confirmationToken });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('surfaces Resend rejection while still attempting the other admins', async () => {
    const t = await setup();
    const waitlistId = await t.run((ctx) =>
      ctx.db.insert('waitlist', {
        email: 'new@example.com',
        confirmed: false,
        confirmationToken: 'confirmation',
      }),
    );
    send.mockResolvedValue({ data: null, error: { name: 'validation_error' } });
    await expect(
      t.action(internal.integrations.emails.sendWaitlistAdminEmail, {
        waitlistId,
        email: 'new@example.com',
      }),
    ).rejects.toThrow('Waitlist admin email delivery failed');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('surfaces missing recipients', async () => {
    const t = convexTest(schema, modules);
    const waitlistId = await t.run((ctx) =>
      ctx.db.insert('waitlist', {
        email: 'new@example.com',
        confirmed: false,
        confirmationToken: 'confirmation',
      }),
    );
    await expect(
      t.action(internal.integrations.emails.sendWaitlistAdminEmail, {
        waitlistId,
        email: 'new@example.com',
      }),
    ).rejects.toThrow('No enabled admins');
    expect(send).not.toHaveBeenCalled();
  });
});
