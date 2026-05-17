import { describe, expect, it } from 'vitest';
import { sortFilterOptions } from '../sortFilterOptions';

describe('sortFilterOptions', () => {
  it('sorts values alphabetically', () => {
    expect(sortFilterOptions(['zebra', 'alpha', 'beta'])).toEqual(['alpha', 'beta', 'zebra']);
  });

  it('sorts case-insensitively', () => {
    expect(sortFilterOptions(['GPT-4', 'claude', 'Anthropic'])).toEqual([
      'Anthropic',
      'claude',
      'GPT-4',
    ]);
  });

  it('deduplicates values', () => {
    expect(sortFilterOptions(['openai', 'openai', 'anthropic'])).toEqual(['anthropic', 'openai']);
  });

  it('sorts by labelMap display labels when provided', () => {
    const labelMap = new Map([
      ['key-z', 'Zebra Key'],
      ['key-a', 'Alpha Key'],
      ['key-m', 'Mango Key'],
    ]);
    expect(sortFilterOptions(['key-z', 'key-a', 'key-m'], labelMap)).toEqual([
      'key-a',
      'key-m',
      'key-z',
    ]);
  });

  it('falls back to raw value when labelMap entry is missing', () => {
    const labelMap = new Map([['key-a', 'Alpha Key']]);
    expect(sortFilterOptions(['zebra', 'key-a'], labelMap)).toEqual(['key-a', 'zebra']);
  });
});
