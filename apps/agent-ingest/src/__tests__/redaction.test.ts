import { describe, it, expect } from 'vitest';
import canary from '../../../../fixtures/redaction-canary.json';
import { MAX_COMMAND_EXCERPT, capExcerpt, redactField } from '../redaction';

interface CanaryCase {
  name: string;
  category: string;
  input: string;
  secret: string;
  expect: 'drop' | 'mask';
}

const corpus = canary as { version: number; cases: CanaryCase[] };

describe('redaction canary corpus', () => {
  it('has the expected shape', () => {
    expect(corpus.version).toBe(1);
    expect(corpus.cases.length).toBeGreaterThanOrEqual(12);
  });

  for (const c of corpus.cases) {
    it(`${c.expect}s the ${c.name} secret and counts it`, () => {
      const { value, dropped } = redactField(c.input);

      // The planted secret must never survive, regardless of drop vs mask.
      expect(value).not.toContain(c.secret);
      // Every case plants exactly one secret, so the field records at least one redaction.
      expect(dropped).toBeGreaterThanOrEqual(1);

      if (c.expect === 'drop') {
        expect(value).toBe('');
      } else {
        // Mask keeps the surrounding structure: the field is not blanked.
        expect(value.length).toBeGreaterThan(0);
      }
    });
  }
});

describe('redactField', () => {
  it('returns clean text untouched with zero drops', () => {
    expect(redactField('git status --short')).toEqual({ value: 'git status --short', dropped: 0 });
  });

  it('passes empty input through', () => {
    expect(redactField('')).toEqual({ value: '', dropped: 0 });
  });
});

describe('capExcerpt', () => {
  it('truncates to the cap', () => {
    expect(capExcerpt('a'.repeat(MAX_COMMAND_EXCERPT + 50), MAX_COMMAND_EXCERPT)).toHaveLength(
      MAX_COMMAND_EXCERPT,
    );
  });

  it('leaves shorter text unchanged', () => {
    expect(capExcerpt('short', MAX_COMMAND_EXCERPT)).toBe('short');
  });

  it('never splits a surrogate pair at the cap boundary', () => {
    const out = capExcerpt('😀'.repeat(10), 5); // each emoji is 2 UTF-16 code units
    expect([...out]).toHaveLength(5);
    expect(out).toBe('😀'.repeat(5));
    expect(out).not.toContain('�');
  });
});
