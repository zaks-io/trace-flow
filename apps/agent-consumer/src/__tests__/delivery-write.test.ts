import { afterEach, describe, expect, it, vi } from 'vitest';
import { deliveryCategoryIsPresent, writeDeliveryCategory } from '../delivery-write';

const env = {
  TINYBIRD_TOKEN: 'append-test',
  TINYBIRD_AGENT_DELIVERY_READ_TOKEN: 'read-test',
  TINYBIRD_HOST: 'https://tinybird.test',
};
const row = {
  OrgId: 'org',
  session_pk: 'session',
  message_pk: 'message',
  EventAt: '2026-09-13 00:00:00.000',
  IsDeleted: 0,
  ContentHash: 'a'.repeat(64),
};
afterEach(() => vi.unstubAllGlobals());

describe('delivery canonical transport', () => {
  it('confirms the exact identity and content through a delivery-scoped query', async () => {
    const fetch = vi.fn(async (_url: string) =>
      Response.json({
        data: [
          {
            FactIdentity: 'org\x1fsession\x1fmessage',
            EventDay: '2026-09-13',
            IsDeleted: 0,
            ContentHash: row.ContentHash,
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetch);
    expect(await deliveryCategoryIsPresent(env, 'org', 23, 'messages', [row])).toBe(true);
    const url = new URL(String(fetch.mock.calls[0]?.[0]));
    expect(url.pathname).toBe('/v0/pipes/agent_delivery_receipt.json');
    expect(url.searchParams.get('org_id')).toBe('org');
    expect(url.searchParams.get('delivery_sequence')).toBe('23');
    expect(url.searchParams.get('category')).toBe('messages');
  });

  it('does not treat partial or conflicting receipts as complete', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ data: [] })),
    );
    expect(await deliveryCategoryIsPresent(env, 'org', 23, 'messages', [row])).toBe(false);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          data: [
            {
              FactIdentity: 'org\x1fsession\x1fmessage',
              EventDay: '2026-09-13',
              IsDeleted: 0,
              ContentHash: 'b'.repeat(64),
            },
          ],
        }),
      ),
    );
    await expect(deliveryCategoryIsPresent(env, 'org', 23, 'messages', [row])).rejects.toThrow(
      'content conflict',
    );
  });

  it('does not accept a 202 response as confirmed storage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ successful_rows: 1, quarantined_rows: 0 }, { status: 202 }),
      ),
    );
    await expect(writeDeliveryCategory(env, 'messages', [row])).rejects.toThrow();
  });

  it('rejects unexpected identities and conflicting duplicate receipts before retrying a write', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          data: [
            {
              FactIdentity: 'unexpected',
              EventDay: '2026-09-13',
              IsDeleted: 0,
              ContentHash: row.ContentHash,
            },
          ],
        }),
      ),
    );
    await expect(deliveryCategoryIsPresent(env, 'org', 23, 'messages', [row])).rejects.toThrow(
      'Unexpected identities',
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          data: [
            {
              FactIdentity: 'org\x1fsession\x1fmessage',
              EventDay: '2026-09-13',
              IsDeleted: 0,
              ContentHash: 'b'.repeat(64),
            },
            {
              FactIdentity: 'org\x1fsession\x1fmessage',
              EventDay: '2026-09-13',
              IsDeleted: 0,
              ContentHash: row.ContentHash,
            },
          ],
        }),
      ),
    );
    await expect(deliveryCategoryIsPresent(env, 'org', 23, 'messages', [row])).rejects.toThrow(
      'content conflict',
    );
  });

  it('splits historical imports at the Tinybird partition limit', async () => {
    const sizes: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const rows = String(init.body).split('\n');
        sizes.push(rows.length);
        return Response.json({ successful_rows: rows.length, quarantined_rows: 0 });
      }),
    );
    const rows = Array.from({ length: 65 }, (_, index) => ({
      ...row,
      EventAt: new Date(Date.UTC(2026, 0, index + 1))
        .toISOString()
        .replace('T', ' ')
        .replace('Z', ''),
    }));
    await writeDeliveryCategory(env, 'messages', rows);
    expect(sizes).toEqual([30, 30, 5]);
  });
});
