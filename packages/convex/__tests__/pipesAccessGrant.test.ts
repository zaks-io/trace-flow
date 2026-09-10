import { decodeJwt, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import { signPipesAccessGrant, verifyPipesAccessGrant } from '../pipesAccessGrant';

describe('Pipes access grants', () => {
  it('binds the user, organization, and pipe without producing a Tinybird credential', async () => {
    const result = await signPipesAccessGrant(
      { userId: 'user-id', orgId: 'org-id', pipe: 'traces_list' },
      'pipes-secret',
      300,
    );

    await expect(verifyPipesAccessGrant(result.token, 'pipes-secret')).resolves.toMatchObject({
      userId: 'user-id',
      orgId: 'org-id',
      pipe: 'traces_list',
      expiresAt: result.expiresAt,
    });
    const payload = decodeJwt(result.token);
    expect(payload).not.toHaveProperty('workspace_id');
    expect(payload).not.toHaveProperty('scopes');
    await expect(
      jwtVerify(result.token, new TextEncoder().encode('tinybird-admin-secret')),
    ).rejects.toThrow();
  });

  it('rejects expired grants', async () => {
    const result = await signPipesAccessGrant(
      { userId: 'user-id', orgId: 'org-id' },
      'pipes-secret',
      -1,
    );
    await expect(verifyPipesAccessGrant(result.token, 'pipes-secret')).resolves.toBeNull();
  });
});
