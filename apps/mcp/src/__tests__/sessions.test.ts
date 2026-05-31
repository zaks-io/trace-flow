import { describe, it, expect } from 'vitest';
import { SignJWT } from 'jose';
import { mintSessionToken, verifySessionToken } from '../sessions';

const SECRET = 'test-session-secret-at-least-32-bytes-long';

describe('stateless session tokens', () => {
  it('round-trips userId + protocolVersion', async () => {
    const token = await mintSessionToken(
      { userId: 'user-1', protocolVersion: '2025-06-18' },
      SECRET,
    );
    const claims = await verifySessionToken(token, SECRET);
    expect(claims).toEqual({ userId: 'user-1', protocolVersion: '2025-06-18' });
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await mintSessionToken(
      { userId: 'user-1', protocolVersion: '2025-06-18' },
      SECRET,
    );
    expect(await verifySessionToken(token, 'a-different-secret-also-32-bytes-long!')).toBeNull();
  });

  it('rejects a malformed token', async () => {
    expect(await verifySessionToken('not.a.jwt', SECRET)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const token = await new SignJWT({ userId: 'user-1', protocolVersion: '2025-06-18' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) - 1)
      .sign(new TextEncoder().encode(SECRET));

    expect(await verifySessionToken(token, SECRET)).toBeNull();
  });
});
