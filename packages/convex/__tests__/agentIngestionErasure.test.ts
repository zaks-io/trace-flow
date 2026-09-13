import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeFunctionReference } from 'convex/server';
import { initConvexTest } from './convexTest.setup';

const erase = makeFunctionReference<'action'>('agentIngestionErasure:eraseOrganization');
async function fixture() {
  const t = initConvexTest();
  const orgId = await t.run(async (ctx) => {
    const ownerId = await ctx.db.insert('users', {
      email: 'erasure@example.com',
      tokenIdentifier: 'erasure',
      enabled: true,
    });
    return ctx.db.insert('organizations', { name: 'Erasure', ownerId });
  });
  vi.stubEnv('AGENT_INGEST_URL', 'https://collector.example.com');
  vi.stubEnv('AGENT_INGEST_SHARED_SECRET', 'internal-secret');
  return { t, orgId };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('agent ingestion erasure control plane', () => {
  it('waits for confirmation and uses internal authority', async () => {
    const { t, orgId } = await fixture();
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ ready: false }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ ready: true }));
    vi.stubGlobal('fetch', fetch);
    const action = t.action(erase, { orgId });
    const verified = expect(action).resolves.toBeNull();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(2001);
    await verified;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]?.[0].toString()).toBe(
      'https://collector.example.com/internal/organization-erasure',
    );
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      headers: { Authorization: 'Bearer internal-secret' },
      body: JSON.stringify({ orgId }),
    });
  });

  it.each([
    { status: 503, body: { error: 'unavailable' } },
    { status: 200, body: { ready: false } },
    { status: 202, body: { ready: true } },
    { status: 200, body: {} },
  ])(
    'does not confirm an unsuccessful or malformed response ($status)',
    async ({ status, body }) => {
      const { t, orgId } = await fixture();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(body, { status })));
      await expect(t.action(erase, { orgId })).rejects.toThrow();
    },
  );
});
