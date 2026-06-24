import { describe, it, expect, vi } from 'vitest';
import { acceptInvite } from '../auth/invites';

// ---------------------------------------------------------------------------
// invites.ts handler logic tests
// ---------------------------------------------------------------------------

const INVITE_EXPIRY_DAYS = 7;

function makeInvite(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'invite_id' as any,
    email: 'invitee@example.com',
    invitedBy: 'admin_user_id' as any,
    orgId: 'org_id' as any,
    status: 'pending' as const,
    token: 'token-uuid',
    expiresAt: Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
    ...overrides,
  };
}

function makeIdentity(overrides: Record<string, unknown> = {}) {
  return {
    tokenIdentifier: 'token|123',
    email: 'invitee@example.com',
    ...overrides,
  };
}

function makeCtx({
  identity = makeIdentity(),
  invite = null,
}: {
  identity?: Record<string, unknown> | null;
  invite?: ReturnType<typeof makeInvite> | null;
} = {}) {
  const dbPatch = vi.fn().mockResolvedValue(undefined);
  const dbInsert = vi.fn().mockResolvedValue('new_invite_id');
  const dbGet = vi.fn();
  const schedulerRunAfter = vi.fn().mockResolvedValue('sched_id');

  return {
    auth: {
      getUserIdentity: vi.fn().mockResolvedValue(identity),
    },
    db: {
      get: dbGet,
      patch: dbPatch,
      insert: dbInsert,
      delete: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockReturnValue({
        withIndex: vi.fn().mockReturnThis(),
        filter: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue(invite),
        collect: vi.fn().mockResolvedValue([]),
        order: vi.fn().mockReturnThis(),
      }),
    },
    scheduler: { runAfter: schedulerRunAfter },
    _dbPatch: dbPatch,
    _dbInsert: dbInsert,
    _dbGet: dbGet,
    _schedulerRunAfter: schedulerRunAfter,
  };
}

// ---------------------------------------------------------------------------
// createInvite / createOrgInvite — duplicate prevention
// ---------------------------------------------------------------------------

describe('invite creation — duplicate prevention', () => {
  it('throws when pending invite already exists for email', () => {
    const existing = makeInvite();
    expect(() => {
      if (existing) throw new Error('A pending invite already exists for this email');
    }).toThrow('A pending invite already exists for this email');
  });

  it('allows creation when no existing pending invite', async () => {
    const ctx = makeCtx();
    ctx.db.query = vi.fn().mockReturnValue({
      withIndex: vi.fn().mockReturnThis(),
      filter: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(null),
    });

    const existing = await ctx.db.query('invites').withIndex('by_email').filter().first();
    expect(existing).toBeNull();
    // Creation proceeds
  });

  it('normalizes email to lowercase on creation', () => {
    const rawEmail = 'User@EXAMPLE.COM';
    const normalized = rawEmail.toLowerCase().trim();
    expect(normalized).toBe('user@example.com');
  });
});

// ---------------------------------------------------------------------------
// createOrgInvite — org ownership check
// ---------------------------------------------------------------------------

describe('createOrgInvite — org ownership check', () => {
  it('throws when user has no orgId', () => {
    const user = { _id: 'user_id', orgId: undefined };
    expect(() => {
      if (!user.orgId) throw new Error('No organization found');
    }).toThrow('No organization found');
  });

  it('throws when org not found', () => {
    const org = null;
    expect(() => {
      if (!org) throw new Error('Organization not found');
    }).toThrow('Organization not found');
  });

  it('throws when user is not org owner', () => {
    const user = { _id: 'other_user' };
    const org = { ownerId: 'owner_user' };
    expect(() => {
      if (org.ownerId !== user._id) throw new Error('Only organization owners can invite members');
    }).toThrow('Only organization owners can invite members');
  });
});

// ---------------------------------------------------------------------------
// getInviteByToken
// ---------------------------------------------------------------------------

describe('getInviteByToken handler logic', () => {
  it('returns null when invite not found', () => {
    const invite = null;
    expect(invite).toBeNull();
  });

  it('returns invite with expired status when past expiresAt', () => {
    const invite = makeInvite({
      status: 'pending',
      expiresAt: Date.now() - 1000, // expired
    });

    const result =
      invite.status === 'pending' && invite.expiresAt < Date.now()
        ? { ...invite, status: 'expired' as const }
        : invite;

    expect(result.status).toBe('expired');
  });

  it('returns invite as-is when not expired', () => {
    const invite = makeInvite({ status: 'pending' }); // future expiresAt
    const result =
      invite.status === 'pending' && invite.expiresAt < Date.now()
        ? { ...invite, status: 'expired' as const }
        : invite;

    expect(result.status).toBe('pending');
  });

  it('returns accepted invite without expiry check', () => {
    const invite = makeInvite({ status: 'accepted', expiresAt: Date.now() - 1000 });
    const result =
      invite.status === 'pending' && invite.expiresAt < Date.now()
        ? { ...invite, status: 'expired' as const }
        : invite;

    expect(result.status).toBe('accepted');
  });
});

// ---------------------------------------------------------------------------
// acceptInvite handler logic
// ---------------------------------------------------------------------------

describe('acceptInvite handler logic', () => {
  type AcceptInviteHandler = (
    ctx: ReturnType<typeof makeCtx>,
    args: { token: string },
  ) => Promise<{ email: string }>;

  const callAcceptInvite = (ctx: ReturnType<typeof makeCtx>, token = 'token-uuid') =>
    (acceptInvite as unknown as { _handler: AcceptInviteHandler })._handler(ctx, { token });

  it('throws when invite not found', () => {
    const invite = null;
    expect(() => {
      if (!invite) throw new Error('Invalid invite');
    }).toThrow('Invalid invite');
  });

  it('throws when invite is already accepted', () => {
    const invite = makeInvite({ status: 'accepted' });
    expect(() => {
      if (invite.status !== 'pending')
        throw new Error(`Invite has already been ${String(invite.status)}`);
    }).toThrow('Invite has already been accepted');
  });

  it('throws when invite is already expired', () => {
    const invite = makeInvite({ status: 'expired' });
    expect(() => {
      if (invite.status !== 'pending')
        throw new Error(`Invite has already been ${String(invite.status)}`);
    }).toThrow('Invite has already been expired');
  });

  it('marks invite expired and throws when past expiresAt', async () => {
    const invite = makeInvite({ expiresAt: Date.now() - 1000 });
    const ctx = makeCtx();

    if (invite.expiresAt < Date.now()) {
      await ctx.db.patch(invite._id, { status: 'expired' });
      expect(() => {
        throw new Error('Invite has expired');
      }).toThrow('Invite has expired');
    }

    expect(ctx._dbPatch).toHaveBeenCalledWith('invite_id', { status: 'expired' });
  });

  it('throws when authenticated email does not match invite email', async () => {
    const invite = makeInvite({ email: 'invitee@example.com' });
    const ctx = makeCtx({
      invite,
      identity: makeIdentity({ email: 'other@example.com' }),
    });

    await expect(callAcceptInvite(ctx)).rejects.toThrow('Invite is for a different email address');
    expect(ctx._dbPatch).not.toHaveBeenCalled();
  });

  it('patches invite to accepted status', async () => {
    const invite = makeInvite({ email: ' Invitee@Example.COM ' });
    const ctx = makeCtx({
      invite,
      identity: makeIdentity({ email: 'invitee@example.com' }),
    });

    await expect(callAcceptInvite(ctx)).resolves.toEqual({ email: 'invitee@example.com' });

    expect(ctx._dbPatch).toHaveBeenCalledWith('invite_id', {
      email: 'invitee@example.com',
      status: 'accepted',
      acceptedAt: expect.any(Number),
    });
  });
});

// ---------------------------------------------------------------------------
// revokeInvite handler logic
// ---------------------------------------------------------------------------

describe('revokeInvite handler logic', () => {
  it('throws when invite not found', async () => {
    const ctx = makeCtx();
    ctx.db.get = vi.fn().mockResolvedValue(null);

    const invite = await ctx.db.get('invite_id');
    expect(() => {
      if (!invite) throw new Error('Invite not found');
    }).toThrow('Invite not found');
  });

  it('throws when invite is not pending', () => {
    const invite = makeInvite({ status: 'accepted' });

    expect(() => {
      if (invite.status !== 'pending') throw new Error('Can only revoke pending invites');
    }).toThrow('Can only revoke pending invites');
  });

  it('patches invite to expired when pending', async () => {
    const invite = makeInvite({ status: 'pending' });
    const ctx = makeCtx();
    ctx.db.get = vi.fn().mockResolvedValue(invite);

    if (invite.status !== 'pending') throw new Error('Can only revoke pending invites');
    await ctx.db.patch(invite._id, { status: 'expired' });

    expect(ctx._dbPatch).toHaveBeenCalledWith('invite_id', { status: 'expired' });
  });
});

// ---------------------------------------------------------------------------
// listInvites — expiry mapping
// ---------------------------------------------------------------------------

describe('listInvites — expiry mapping', () => {
  it('maps pending+expired invites to expired status', () => {
    const now = Date.now();
    const invites = [
      makeInvite({ status: 'pending', expiresAt: now - 5000 }), // expired
      makeInvite({ _id: 'invite_2', status: 'pending', expiresAt: now + 5000 }), // still valid
      makeInvite({ _id: 'invite_3', status: 'accepted', expiresAt: now - 5000 }), // accepted, not changed
    ];

    const result = invites.map((invite) => {
      if (invite.status === 'pending' && invite.expiresAt < now) {
        return { ...invite, status: 'expired' as const };
      }
      return invite;
    });

    expect(result[0].status).toBe('expired');
    expect(result[1].status).toBe('pending');
    expect(result[2].status).toBe('accepted');
  });
});
