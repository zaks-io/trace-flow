import { describe, it, expect } from 'vitest';
import { djb2Hash, hashString } from '../index';

describe('djb2Hash', () => {
  it('should return a number', () => {
    const hash = djb2Hash('test');
    expect(typeof hash).toBe('number');
  });

  it('should return a positive integer', () => {
    const hash = djb2Hash('test');
    expect(hash).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(hash)).toBe(true);
  });

  it('should be deterministic', () => {
    const input = 'consistent input';
    const hash1 = djb2Hash(input);
    const hash2 = djb2Hash(input);
    const hash3 = djb2Hash(input);

    expect(hash1).toBe(hash2);
    expect(hash2).toBe(hash3);
  });

  it('should produce different hashes for different inputs', () => {
    const hash1 = djb2Hash('hello');
    const hash2 = djb2Hash('world');
    const hash3 = djb2Hash('test');

    expect(hash1).not.toBe(hash2);
    expect(hash2).not.toBe(hash3);
    expect(hash1).not.toBe(hash3);
  });

  it('should handle empty strings', () => {
    const hash = djb2Hash('');
    expect(hash).toBe(0);
  });

  it('should handle single character strings', () => {
    const hash = djb2Hash('a');
    expect(hash).toBeGreaterThan(0);
  });

  it('should handle long strings', () => {
    const longString = 'a'.repeat(10000);
    const hash = djb2Hash(longString);
    expect(hash).toBeGreaterThan(0);
    expect(Number.isInteger(hash)).toBe(true);
  });

  it('should handle strings with special characters', () => {
    const hash1 = djb2Hash('Hello, World! 🌍');
    const hash2 = djb2Hash('Special chars: @#$%^&*()');

    expect(hash1).toBeGreaterThan(0);
    expect(hash2).toBeGreaterThan(0);
    expect(hash1).not.toBe(hash2);
  });

  it('should produce different hashes for similar strings', () => {
    const hash1 = djb2Hash('test');
    const hash2 = djb2Hash('Test');
    const hash3 = djb2Hash('tests');

    expect(hash1).not.toBe(hash2);
    expect(hash2).not.toBe(hash3);
    expect(hash1).not.toBe(hash3);
  });
});

describe('hashString (backward compat alias)', () => {
  it('should be identical to djb2Hash', () => {
    expect(hashString('test')).toBe(djb2Hash('test'));
    expect(hashString('')).toBe(djb2Hash(''));
    expect(hashString('hello world')).toBe(djb2Hash('hello world'));
  });
});
