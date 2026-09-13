import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareDeliveryPartitions } from '../delivery-partitions';
import { emptyAccumulator } from '../facts';
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
          DeliverySequence: 3,
          IsDeleted: 0,
          ContentHash: 'a'.repeat(64),
          output_tokens: 12,
        },
      ],
    },
  };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('delivery partition corrections', () => {
  it('writes a tombstone in the old partition and dirties both days', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          data: [
            {
              FactIdentity: 'org\x1fs\x1fm',
              EventDay: '2026-09-12',
              DeliverySequence: 2,
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
              FactIdentity: 'org\x1fs\x1fm',
              EventDay: '2026-09-13',
              DeliverySequence: '2',
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
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input : input.url,
      );
      expect(url.searchParams.get('oldest_day')).toBe('2023-03-01');
      expect(url.searchParams.get('today_day')).toBe('2024-02-29');
      expect(url.searchParams.get('identities')).toBe('org\x1fs\x1fm');
      return Response.json({ data: [] });
    });
    vi.stubGlobal('fetch', fetch);
    const plan = delivery();
    expect(await prepareDeliveryPartitions(env, plan)).toEqual(['2026-09-13']);
    expect(plan.rows.messages).toHaveLength(1);
    expect(fetch).toHaveBeenCalled();
  });

  it('rejects a later revision or foreign identity before changing the plan', async () => {
    for (const entry of [
      { FactIdentity: 'org\x1fs\x1fm', EventDay: '2026-09-12', DeliverySequence: 4 },
      { FactIdentity: 'another-org\x1fs\x1fm', EventDay: '2026-09-12', DeliverySequence: 2 },
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
});
