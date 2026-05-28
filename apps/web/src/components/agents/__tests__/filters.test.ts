import { describe, expect, it } from 'vitest';
import { toggleInList } from '../filters';

describe('toggleInList (click-to-filter)', () => {
  it('adds a value that is absent', () => {
    expect(toggleInList(['claude'], 'codex')).toEqual(['claude', 'codex']);
  });

  it('removes a value that is present', () => {
    expect(toggleInList(['claude', 'codex'], 'claude')).toEqual(['codex']);
  });

  it('toggling the same value twice restores the original list', () => {
    const once = toggleInList(['claude'], 'codex');
    expect(toggleInList(once, 'codex')).toEqual(['claude']);
  });

  it('does not mutate the input list', () => {
    const input = ['claude'];
    toggleInList(input, 'codex');
    expect(input).toEqual(['claude']);
  });
});
