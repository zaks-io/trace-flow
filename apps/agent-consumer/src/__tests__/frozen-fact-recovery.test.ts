import { describe, expect, it } from 'vitest';
import {
  inspectLatestFrozenFact,
  selectLatestFrozenFact,
  validateReplayFrozenFactsInput,
} from '../frozen-fact-recovery';
import { stableHash } from '../facts';

function row(overrides: Record<string, unknown> = {}) {
  return {
    OrgId: 'org-1',
    session_pk: 'session-1',
    message_pk: 'message-1',
    EventAt: '2026-09-01 00:00:00.000',
    IngestedAt: '2026-09-01 01:00:00.000',
    cost_usd: 12.34,
    ...overrides,
  };
}

describe('frozen fact recovery contracts', () => {
  it('selects the latest trusted source without changing its priced fields', () => {
    const latest = row({ IngestedAt: '2026-09-01 03:00:00.000', cost_usd: 98.765 });
    const selected = selectLatestFrozenFact(
      'org-1',
      {
        category: 'messages',
        factId: 'org-1\x1fsession-1\x1fmessage-1',
        expectedSourceHash: stableHash(latest),
      },
      [row(), latest],
    );
    expect(JSON.parse(selected.payload)).toMatchObject({ cost_usd: 98.765 });
  });

  it('inspects the same latest source without returning its payload', () => {
    const latest = row({ IngestedAt: '2026-09-02 03:00:00.000', cost_usd: 98.765 });
    expect(
      inspectLatestFrozenFact(
        'org-1',
        { category: 'messages', factId: 'org-1\x1fsession-1\x1fmessage-1' },
        [row(), latest],
      ),
    ).toEqual({
      category: 'messages',
      factId: 'org-1\x1fsession-1\x1fmessage-1',
      sourceHash: stableHash(latest),
      payloadBytes: new TextEncoder().encode(JSON.stringify(latest)).byteLength,
      eventDay: '2026-09-01',
      ingestedAt: '2026-09-02 03:00:00.000',
    });
  });

  it('rejects stale source evidence', () => {
    expect(() =>
      selectLatestFrozenFact(
        'org-1',
        {
          category: 'messages',
          factId: 'org-1\x1fsession-1\x1fmessage-1',
          expectedSourceHash: '0'.repeat(16),
        },
        [row()],
      ),
    ).toThrow('source hash changed');
  });

  it('rejects equal-time payload conflicts instead of choosing by iteration order', () => {
    const first = row({ cost_usd: 1 });
    const second = row({ cost_usd: 2 });
    expect(() =>
      selectLatestFrozenFact(
        'org-1',
        {
          category: 'messages',
          factId: 'org-1\x1fsession-1\x1fmessage-1',
          expectedSourceHash: stableHash(first),
        },
        [first, second],
      ),
    ).toThrow('conflicting payloads');
  });

  it('rejects a source with an incomplete natural identity before staging it', () => {
    const invalid = row({ message_pk: '' });
    expect(() =>
      selectLatestFrozenFact(
        'org-1',
        {
          category: 'messages',
          factId: 'org-1\x1fsession-1\x1f',
          expectedSourceHash: stableHash(invalid),
        },
        [invalid],
      ),
    ).toThrow('invalid natural identity');
  });

  it('requires explicit canonical absence or an exact day, revision, and hash', () => {
    const base = {
      deliveryId: '2c345e67-e89b-42d3-a456-426614174000',
      createdAtMs: Date.now(),
      facts: [
        {
          category: 'messages',
          factId: 'org-1\x1fsession-1\x1fmessage-1',
          expectedSourceHash: stableHash(row()),
          expectedCanonical: null,
        },
      ],
    };
    expect(validateReplayFrozenFactsInput(base)).toEqual(base);
    expect(() =>
      validateReplayFrozenFactsInput({
        ...base,
        facts: [{ ...base.facts[0], expectedCanonical: undefined }],
      }),
    ).toThrow('invalid expected canonical fact');
  });
});
