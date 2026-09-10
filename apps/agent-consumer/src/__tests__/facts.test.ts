import { describe, expect, it } from 'vitest';
import { factPartitionKey, stableHash } from '../facts';

describe('stableHash', () => {
  it('ignores ingestion time so replayed facts do not look like repairs', () => {
    const fact = {
      OrgId: 'org-1',
      session_pk: 'session-1',
      message_pk: 'message-1',
      EventAt: '2026-05-20 10:00:00.000',
      IngestedAt: '2026-05-20 12:00:00.000',
      input_tokens: 100,
    };

    expect(stableHash(fact)).toBe(stableHash({ ...fact, IngestedAt: '2026-05-20 12:05:00.000' }));
  });
});

describe('factPartitionKey', () => {
  it('uses the UTC source partition date for SQL and ISO timestamps', () => {
    expect(factPartitionKey('messages', { EventAt: '2026-05-20 23:59:59.999' })).toBe('2026-05-20');
    expect(factPartitionKey('messages', { EventAt: '2026-05-21T00:00:00.000Z' })).toBe(
      '2026-05-21',
    );
    expect(
      factPartitionKey('review_unit_attributions', {
        EventAt: '2026-05-20 00:00:00.000',
        DecidedAt: '2026-05-22 00:00:00.000',
      }),
    ).toBe('2026-05-22');
  });

  it('rejects missing or malformed partition timestamps', () => {
    expect(() => factPartitionKey('tool_events', {})).toThrow('invalid EventAt');
    expect(() => factPartitionKey('messages', { EventAt: '2026-05-20' })).toThrow(
      'invalid EventAt',
    );
  });
});
