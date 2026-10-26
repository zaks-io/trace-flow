import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../_generated/api';
import { initConvexTest } from './convexTest.setup';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('resend', () => ({
  Resend: class {
    emails = { send };
  },
}));

const SIGNUP_SUBJECT = 'New Trace Flow sign-up';

async function setup() {
  const t = initConvexTest();
  const adminId = await t.run(async (ctx) => {
    const adminId = await ctx.db.insert('users', {
      tokenIdentifier: 'admin',
      email: 'admin@example.com',
      enabled: true,
      isAdmin: true,
    });
    await ctx.db.insert('users', {
      tokenIdentifier: 'disabled-admin',
      email: 'disabled@example.com',
      enabled: false,
      isAdmin: true,
    });
    await ctx.db.insert('users', {
      tokenIdentifier: 'member',
      email: 'member@example.com',
      enabled: true,
    });
    return adminId;
  });
  return { t, adminId };
}

function signupEmails() {
  return send.mock.calls.filter(([message]) => message.subject.startsWith(SIGNUP_SUBJECT));
}

describe('new sign-up admin notifications', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // New accounts get an org whose subscription syncs to Cloudflare KV.
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'test-account');
    vi.stubEnv('CLOUDFLARE_API_TOKEN', 'test-token');
    vi.stubEnv('CLOUDFLARE_KV_NAMESPACE_ID', 'subscription-namespace');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('')));
    send.mockReset().mockResolvedValue({ data: { id: 'email-id' }, error: null });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('looks up only enabled admins through the admin/enabled index', async () => {
    const { t } = await setup();
    await t.run(async (ctx) => {
      await ctx.db.insert('users', {
        tokenIdentifier: 'explicit-non-admin',
        email: 'member2@example.com',
        enabled: true,
        isAdmin: false,
      });
      await ctx.db.insert('users', {
        tokenIdentifier: 'duplicate-admin',
        email: ' ADMIN@example.com ',
        enabled: true,
        isAdmin: true,
      });
      const query = ctx.db
        .query('users')
        .withIndex('by_is_admin_enabled', (q) => q.eq('isAdmin', true).eq('enabled', true));
      expect((await query.collect()).map((user) => user.tokenIdentifier).sort()).toEqual([
        'admin',
        'duplicate-admin',
      ]);
    });
    expect(await t.query(internal.auth.users.getAdminEmails, {})).toEqual(['admin@example.com']);
  });

  it('emails enabled admins once when someone signs up on the web', async () => {
    const { t } = await setup();
    const newcomer = t.withIdentity({
      tokenIdentifier: 'https://auth.example/|auth0|newcomer',
      email: 'Newcomer@Example.com',
      emailVerified: true,
      name: 'New Comer',
    });

    await newcomer.mutation(api.auth.users.initializeUser, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const emails = signupEmails();
    expect(emails.map(([message]) => message.to)).toEqual(['admin@example.com']);
    const [message, options] = emails[0];
    expect(message.subject).toBe(`${SIGNUP_SUBJECT}: newcomer@example.com`);
    expect(message.text).toContain('New Comer <newcomer@example.com>');
    expect(message.text).toContain('through open sign-up');
    expect(message.text).not.toContain('not verified');
    expect(options.idempotencyKey).toMatch(/^user-signup\/.+\/admin@example\.com$/);

    await newcomer.mutation(api.auth.users.initializeUser, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(signupEmails()).toHaveLength(1);
  });

  it('tells admins when a web sign-up has not verified its email', async () => {
    const { t } = await setup();

    await t
      .withIdentity({
        tokenIdentifier: 'https://auth.example/|auth0|unverified',
        email: 'someone@example.com',
        emailVerified: false,
      })
      .mutation(api.auth.users.initializeUser, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(signupEmails()[0][0].text).toBe(
      'someone@example.com created a Trace Flow account through open sign-up. Their email address is not verified yet.',
    );
  });

  it('emails admins for MCP OAuth sign-ups and says when the user came from an invite', async () => {
    const { t, adminId } = await setup();
    await t.run((ctx) =>
      ctx.db.insert('invites', {
        email: 'invited@example.com',
        invitedBy: adminId,
        status: 'accepted',
        token: 'invite-token',
        expiresAt: Date.now() + 60_000,
      }),
    );

    await t.mutation(internal.auth.users.findOrCreateUser, {
      tokenIdentifier: 'https://auth.example/|auth0|invited',
      email: 'invited@example.com',
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const emails = signupEmails();
    expect(emails).toHaveLength(1);
    expect(emails[0][0].text).toBe(
      'invited@example.com created a Trace Flow account from an invite.',
    );
  });

  it('fails loudly when Resend rejects the notification', async () => {
    const { t } = await setup();
    const userId = await t.run((ctx) =>
      ctx.db.insert('users', { tokenIdentifier: 'new', email: 'new@example.com', enabled: true }),
    );
    send.mockResolvedValue({ data: null, error: { name: 'validation_error' } });

    await expect(
      t.action(internal.integrations.emails.sendSignupAdminEmail, {
        userId,
        email: 'new@example.com',
        emailVerified: true,
        invited: false,
      }),
    ).rejects.toThrow(`Admin email delivery failed: ${SIGNUP_SUBJECT}: new@example.com`);
  });
});
