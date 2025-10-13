import { describe, it, expect } from 'vitest';
import { hashString } from '../index';

describe('hashString', () => {
  it('should return a number', () => {
    const hash = hashString('test');
    expect(typeof hash).toBe('number');
  });

  it('should return a positive integer', () => {
    const hash = hashString('test');
    expect(hash).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(hash)).toBe(true);
  });

  it('should be deterministic', () => {
    const input = 'consistent input';
    const hash1 = hashString(input);
    const hash2 = hashString(input);
    const hash3 = hashString(input);

    expect(hash1).toBe(hash2);
    expect(hash2).toBe(hash3);
  });

  it('should produce different hashes for different inputs', () => {
    const hash1 = hashString('hello');
    const hash2 = hashString('world');
    const hash3 = hashString('test');

    expect(hash1).not.toBe(hash2);
    expect(hash2).not.toBe(hash3);
    expect(hash1).not.toBe(hash3);
  });

  it('should handle empty strings', () => {
    const hash = hashString('');
    expect(hash).toBe(0);
  });

  it('should handle single character strings', () => {
    const hash = hashString('a');
    expect(hash).toBeGreaterThan(0);
  });

  it('should handle long strings', () => {
    const longString = 'a'.repeat(10000);
    const hash = hashString(longString);
    expect(hash).toBeGreaterThan(0);
    expect(Number.isInteger(hash)).toBe(true);
  });

  it('should handle strings with special characters', () => {
    const hash1 = hashString('Hello, World! 🌍');
    const hash2 = hashString('Special chars: @#$%^&*()');

    expect(hash1).toBeGreaterThan(0);
    expect(hash2).toBeGreaterThan(0);
    expect(hash1).not.toBe(hash2);
  });

  it('should produce different hashes for similar strings', () => {
    const hash1 = hashString('test');
    const hash2 = hashString('Test');
    const hash3 = hashString('tests');

    expect(hash1).not.toBe(hash2);
    expect(hash2).not.toBe(hash3);
    expect(hash1).not.toBe(hash3);
  });
});
