import { describe, expect, it, vi } from 'vitest';
import { requireEnabledActionUser } from '../auth/actionUser';

function makeCtx(
  user: Record<string, unknown> | null,
  authenticated = true,
  activeMembership = true,
) {
  return {
    auth: {
      getUserIdentity: vi
        .fn()
        .mockResolvedValue(
          authenticated ? { tokenIdentifier: 'https://auth.example/|auth0|user' } : null,
        ),
    },
    runQuery: vi.fn().mockResolvedValueOnce(user).mockResolvedValueOnce(activeMembership),
  };
}

describe('requireEnabledActionUser', () => {
  it('rejects an unauthenticated action', async () => {
    const ctx = makeCtx(null, false);
    await expect(requireEnabledActionUser(ctx as never)).rejects.toThrow('Authentication required');
    expect(ctx.runQuery).not.toHaveBeenCalled();
  });

  it('rejects a disabled account', async () => {
    const ctx = makeCtx({ _id: 'user', enabled: false });
    await expect(requireEnabledActionUser(ctx as never)).rejects.toThrow(
      'User account is not enabled',
    );
  });

  it('returns the enabled account bound to the session identity', async () => {
    const user = { _id: 'user', enabled: true, orgId: 'org' };
    const ctx = makeCtx(user);
    await expect(requireEnabledActionUser(ctx as never)).resolves.toBe(user);
    expect(ctx.runQuery).toHaveBeenCalledWith(expect.anything(), {
      tokenIdentifier: 'https://auth.example/|auth0|user',
    });
  });

  it('rejects an enabled account without a live active organization membership', async () => {
    const ctx = makeCtx({ _id: 'user', enabled: true, orgId: 'deleted-org' }, true, false);
    await expect(requireEnabledActionUser(ctx as never)).rejects.toThrow(
      'Active organization membership required',
    );
  });
});
