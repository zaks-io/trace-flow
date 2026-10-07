import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '@trace-flow/utils';
import { prepareDeliveryPartitions } from '../delivery-partitions';
import { CATEGORIES, ROW_IDENTITY_FIELDS, emptyAccumulator } from '../facts';
import type { DeliveryRows } from '../delivery-rows';

const env = {
  TINYBIRD_HOST: 'https://tinybird.test',
  TINYBIRD_AGENT_DELIVERY_READ_TOKEN: 'read-test',
};
function delivery(): DeliveryRows {
  return {
    orgId: 'org',
    revision: 3,
    expiresAt: Date.now() + 60_000,
    rows: {
      ...emptyAccumulator(),
      messages: [
        {
          OrgId: 'org',
          session_pk: 's',
          message_pk: 'm',
          EventAt: '2026-09-13 01:00:00.000',
          IngestedAt: '2026-09-13 01:00:00.000',
          DeliverySequence: 3,
          IsDeleted: 0,
          ContentHash: 'a'.repeat(64),
          output_tokens: 12,
        },
      ],
    },
  };
}
function lookupBody(init?: RequestInit): URLSearchParams {
  expect(init?.body).toBeInstanceOf(URLSearchParams);
  return init!.body as URLSearchParams;
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('delivery partition corrections', () => {
  it('looks up every category of a delivery in one request', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-06T00:00:00Z'));
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(
        'https://tinybird.test/v0/pipes/agent_fact_identity_day_batch.json',
      );
      expect(init?.method).toBe('POST');
      const body = lookupBody(init);
      expect(body.get('org_id')).toBe('org');
      expect(body.get('oldest_day')).toBe('2025-10-06');
      expect(body.get('today_day')).toBe('2026-10-06');
      const categories = body.get('categories')!.split(',');
      const identities = body.get('identities')!.split(',');
      expect(categories).toHaveLength(CATEGORIES.length * 33);
      expect(identities).toHaveLength(categories.length);
      expect(new Set(categories)).toEqual(new Set(CATEGORIES));
      for (const [index, category] of categories.entries()) {
        expect(identities[index]).toMatch(new RegExp(`\\x1f${category}-\\d+$`));
      }
      return Response.json({ data: [] });
    });
    vi.stubGlobal('fetch', fetch);
    const plan = delivery();
    const template = plan.rows.messages[0] as Record<string, unknown>;
    for (const category of CATEGORIES) {
      plan.rows[category] = Array.from({ length: 33 }, (_, index) => ({
        ...template,
        DecidedAt: template.EventAt,
        [ROW_IDENTITY_FIELDS[category][2]!]: `${category}-${index}`,
      }));
    }

    expect(await prepareDeliveryPartitions(env, plan)).toEqual(['2026-09-13']);
    expect(fetch).toHaveBeenCalledTimes(1);
    for (const category of CATEGORIES) expect(plan.rows[category]).toHaveLength(33);
  });

  it('writes a tombstone in the old partition and dirties both days', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          data: [
            {
              Category: 'messages',
              FactIdentity: 'org\x1fs\x1fm',
              EventDay: '2026-09-12',
              DeliverySequence: 2,
              ContentHash: 'b'.repeat(64),
              IngestedAt: '2026-09-13 00:00:00.000',
            },
          ],
        }),
      ),
    );
    const plan = delivery();
    expect(await prepareDeliveryPartitions(env, plan)).toEqual(['2026-09-12', '2026-09-13']);
    expect(plan.rows.messages).toHaveLength(2);
    expect(plan.rows.messages[0]).toMatchObject({
      EventAt: '2026-09-13 01:00:00.000',
      IsDeleted: 0,
    });
    expect(plan.rows.messages[1]).toMatchObject({
      OrgId: 'org',
      session_pk: 's',
      message_pk: 'm',
      EventAt: '2026-09-12 00:00:00.000',
      DeliverySequence: 3,
      IsDeleted: 1,
    });
    expect((plan.rows.messages[1] as Record<string, unknown>).ContentHash).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it('does not generate deletions for new identities or same-day corrections', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ data: [] })),
    );
    const fresh = delivery();
    expect(await prepareDeliveryPartitions(env, fresh)).toEqual(['2026-09-13']);
    expect(fresh.rows.messages).toHaveLength(1);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          data: [
            {
              Category: 'messages',
              FactIdentity: 'org\x1fs\x1fm',
              EventDay: '2026-09-13',
              DeliverySequence: '2',
              ContentHash: 'b'.repeat(64),
              IngestedAt: '2026-09-13 00:00:00.000',
            },
          ],
        }),
      ),
    );
    const correction = delivery();
    await prepareDeliveryPartitions(env, correction);
    expect(correction.rows.messages).toHaveLength(1);
  });

  it('bounds identity lookups to the exact retained calendar days', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-02-29T12:00:00.000Z'));
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = lookupBody(init);
      expect(body.get('oldest_day')).toBe('2023-03-01');
      expect(body.get('today_day')).toBe('2024-02-29');
      expect(body.get('categories')).toBe('messages');
      expect(body.get('identities')).toBe('org\x1fs\x1fm');
      return Response.json({ data: [] });
    });
    vi.stubGlobal('fetch', fetch);
    const plan = delivery();
    expect(await prepareDeliveryPartitions(env, plan)).toEqual(['2026-09-13']);
    expect(plan.rows.messages).toHaveLength(1);
    expect(fetch).toHaveBeenCalled();
  });

  it('keeps row order and appends the tombstone for a large delivery', async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const identities = lookupBody(init).get('identities')!.split(',');
      return Response.json({
        data: identities
          .filter((identity) => identity.endsWith('\x1fm-300'))
          .map((FactIdentity) => ({
            Category: 'messages',
            FactIdentity,
            EventDay: '2026-09-12',
            DeliverySequence: 2,
            ContentHash: 'b'.repeat(64),
            IngestedAt: '2026-09-13 00:00:00.000',
          })),
      });
    });
    vi.stubGlobal('fetch', fetch);
    const plan = delivery();
    const template = plan.rows.messages[0] as Record<string, unknown>;
    plan.rows.messages = Array.from({ length: 321 }, (_, index) => ({
      ...template,
      message_pk: `m-${index}`,
    }));

    expect(await prepareDeliveryPartitions(env, plan)).toEqual(['2026-09-12', '2026-09-13']);
    expect(fetch).toHaveBeenCalledTimes(1);
    const messages = plan.rows.messages as Record<string, unknown>[];
    expect(messages).toHaveLength(322);
    expect(messages.slice(0, 321).map((row) => row.message_pk)).toEqual(
      Array.from({ length: 321 }, (_, index) => `m-${index}`),
    );
    expect(messages[321]).toMatchObject({ message_pk: 'm-300', IsDeleted: 1 });
  });

  it('leaves the plan untouched when a later lookup batch fails', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        if (calls === 3) return new Response('unavailable', { status: 503 });
        return Response.json({ data: [] });
      }),
    );
    const plan = delivery();
    const template = plan.rows.messages[0] as Record<string, unknown>;
    plan.rows.messages = Array.from({ length: 1100 }, (_, index) => ({
      ...template,
      message_pk: `m-${index}`,
    }));
    const before = [...plan.rows.messages];

    await expect(prepareDeliveryPartitions(env, plan)).rejects.toThrow();
    expect(plan.rows.messages).toEqual(before);
  });

  it('rejects a later revision or foreign identity before changing the plan', async () => {
    for (const entry of [
      {
        Category: 'messages',
        FactIdentity: 'org\x1fs\x1fm',
        EventDay: '2026-09-12',
        DeliverySequence: 4,
        ContentHash: 'b'.repeat(64),
        IngestedAt: '2026-09-13 00:00:00.000',
      },
      {
        Category: 'messages',
        FactIdentity: 'another-org\x1fs\x1fm',
        EventDay: '2026-09-12',
        DeliverySequence: 2,
        ContentHash: 'b'.repeat(64),
        IngestedAt: '2026-09-13 00:00:00.000',
      },
    ]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json({ data: [entry] })),
      );
      const plan = delivery();
      await expect(prepareDeliveryPartitions(env, plan)).rejects.toThrow();
      expect(plan.rows.messages).toHaveLength(1);
    }
  });

  it('omits superseded legacy facts while retaining missing and newer facts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          data: [
            {
              Category: 'messages',
              FactIdentity: 'org\x1fs\x1fm',
              EventDay: '2026-09-13',
              DeliverySequence: 2,
              ContentHash: 'b'.repeat(64),
              IngestedAt: '2026-09-13 02:00:00.000',
            },
          ],
        }),
      ),
    );
    const plan = delivery();
    plan.rows.messages.push(
      {
        ...(plan.rows.messages[0] as Record<string, unknown>),
        message_pk: 'missing',
        IngestedAt: '2026-09-13 01:30:00.000',
      },
      {
        ...(plan.rows.messages[0] as Record<string, unknown>),
        message_pk: 'newer',
        IngestedAt: '2026-09-13 03:00:00.000',
      },
    );

    expect(await prepareDeliveryPartitions(env, plan, { legacySourceOrder: true })).toEqual([
      '2026-09-13',
    ]);
    expect(plan.rows.messages.map((row) => (row as Record<string, unknown>).message_pk)).toEqual([
      'missing',
      'newer',
    ]);
  });

  it('accepts only a proven equal-time duplicate and rejects an equal-time conflict', async () => {
    const exact = delivery();
    const row = exact.rows.messages[0] as Record<string, unknown>;
    const currentVersion: Record<string, unknown> = { ...row, DeliverySequence: 2, IsDeleted: 0 };
    delete currentVersion.ContentHash;
    const current = {
      Category: 'messages',
      FactIdentity: 'org\x1fs\x1fm',
      EventDay: '2026-09-13',
      DeliverySequence: 2,
      ContentHash: await sha256Hex(JSON.stringify(currentVersion)),
      IngestedAt: row.IngestedAt,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ data: [current] })),
    );

    expect(await prepareDeliveryPartitions(env, exact, { legacySourceOrder: true })).toEqual([]);
    expect(exact.rows.messages).toEqual([]);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ data: [{ ...current, ContentHash: 'b'.repeat(64) }] })),
    );
    await expect(
      prepareDeliveryPartitions(env, delivery(), { legacySourceOrder: true }),
    ).rejects.toThrow('Conflicting equal-time messages fact');
  });
});
