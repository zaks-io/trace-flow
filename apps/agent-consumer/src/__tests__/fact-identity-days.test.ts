import { afterEach, describe, expect, it, vi } from 'vitest';
import { lookupFactIdentityDays } from '../fact-identity-days';

const env = {
  TINYBIRD_HOST: 'https://tinybird.test',
  TINYBIRD_AGENT_DELIVERY_READ_TOKEN: 'read-test',
};

function lookupBody(init?: RequestInit): { categories: string[]; identities: string[] } {
  const body = init?.body as URLSearchParams;
  return {
    categories: body.get('categories')!.split(','),
    identities: body.get('identities')!.split(','),
  };
}

function current(Category: string, FactIdentity: string) {
  return {
    Category,
    FactIdentity,
    EventDay: '2026-09-12',
    DeliverySequence: '2',
    ContentHash: 'b'.repeat(64),
    IngestedAt: '2026-09-13 00:00:00.000',
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fact identity day lookup', () => {
  it('returns current days by category from one paired request', async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const { categories, identities } = lookupBody(init);
      expect(categories).toEqual(['messages', 'tool_events']);
      expect(identities).toEqual(['org\x1fs\x1fshared', 'org\x1fs\x1fshared']);
      return Response.json({ data: [current('tool_events', 'org\x1fs\x1fshared')] });
    });
    vi.stubGlobal('fetch', fetch);

    const found = await lookupFactIdentityDays(env, 'org', {
      messages: ['org\x1fs\x1fshared', 'org\x1fs\x1fshared'],
      tool_events: ['org\x1fs\x1fshared'],
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(found.messages.size).toBe(0);
    expect(found.tool_events.get('org\x1fs\x1fshared')).toMatchObject({
      EventDay: '2026-09-12',
      DeliverySequence: 2,
    });
  });

  it('splits oversized lookups by identity count and query bytes', async () => {
    const batches: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        batches.push(lookupBody(init).identities.length);
        return Response.json({ data: [] });
      }),
    );

    await lookupFactIdentityDays(env, 'org', {
      messages: Array.from({ length: 1_025 }, (_, index) => `org\x1fs\x1f${index}`),
    });
    await lookupFactIdentityDays(env, 'org', {
      messages: Array.from(
        { length: 100 },
        (_, index) => `org\x1f${'s'.repeat(1_500)}\x1f${index}`,
      ),
    });

    expect(batches).toEqual([512, 512, 1, 43, 43, 14]);
  });

  it('budgets query bytes in UTF-8, not characters', async () => {
    const batches: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        batches.push(lookupBody(init).identities.length);
        return Response.json({ data: [] });
      }),
    );

    await lookupFactIdentityDays(env, 'org', {
      messages: Array.from({ length: 40 }, (_, index) => `org\x1f${'é'.repeat(1_000)}\x1f${index}`),
    });

    expect(batches).toEqual([32, 8]);
  });

  it('makes no request when there is nothing to look up', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    const found = await lookupFactIdentityDays(env, 'org', { messages: [] });

    expect(fetch).not.toHaveBeenCalled();
    expect(found.messages.size).toBe(0);
  });

  it('runs at most six batches at once', async () => {
    let open = 0;
    let peak = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        open += 1;
        peak = Math.max(peak, open);
        await new Promise((resolve) => setTimeout(resolve, 1));
        open -= 1;
        return Response.json({ data: [] });
      }),
    );

    await lookupFactIdentityDays(env, 'org', {
      messages: Array.from({ length: 512 * 7 }, (_, index) => `org\x1fs\x1f${index}`),
    });

    expect(peak).toBe(6);
  });

  it('rejects rows for an identity under a category it was not requested in', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ data: [current('tool_events', 'org\x1fs\x1fm')] })),
    );

    await expect(
      lookupFactIdentityDays(env, 'org', { messages: ['org\x1fs\x1fm'] }),
    ).rejects.toThrow('Unexpected or duplicate identity day response');
  });

  it('rejects a duplicate row for one requested identity', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          data: [current('messages', 'org\x1fs\x1fm'), current('messages', 'org\x1fs\x1fm')],
        }),
      ),
    );

    await expect(
      lookupFactIdentityDays(env, 'org', { messages: ['org\x1fs\x1fm'] }),
    ).rejects.toThrow('Unexpected or duplicate identity day response');
  });

  it('rejects a response without rows instead of treating it as empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({})),
    );

    await expect(
      lookupFactIdentityDays(env, 'org', { messages: ['org\x1fs\x1fm'] }),
    ).rejects.toThrow('no data array');
  });

  it('rejects identities the Array parameter cannot encode', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    for (const identity of ['', 'contains,a,comma']) {
      await expect(lookupFactIdentityDays(env, 'org', { messages: [identity] })).rejects.toThrow(
        'Invalid fact identity lookup',
      );
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
