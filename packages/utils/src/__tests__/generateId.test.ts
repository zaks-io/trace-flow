import { describe, it, expect } from 'vitest';
import { generateId } from '../index';

describe('generateId', () => {
  it('should generate a valid UUID v4', () => {
    const id = generateId();
    const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(id).toMatch(uuidV4Regex);
  });

  it('should generate unique IDs', () => {
    const id1 = generateId();
    const id2 = generateId();
    const id3 = generateId();

    expect(id1).not.toBe(id2);
    expect(id2).not.toBe(id3);
    expect(id1).not.toBe(id3);
  });

  it('should generate IDs with correct format', () => {
    const id = generateId();
    expect(id).toHaveLength(36);
    expect(id.split('-')).toHaveLength(5);
  });
});
