import { describe, expect, it } from 'vitest';
import { stableHash } from '../facts';

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
