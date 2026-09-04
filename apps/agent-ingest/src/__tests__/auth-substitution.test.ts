import { describe, expect, it } from 'vitest';
import { authenticateCollectorCredential } from '@trace-flow/utils';
import { authenticateCollector } from '../auth';

describe('Collector Credential auth extraction', () => {
  it('substitutes the shared authenticator instead of keeping a local copy', () => {
    expect(authenticateCollectorCredential).toEqual(expect.any(Function));
    expect(authenticateCollector.toString()).toContain('authenticateCollectorCredential');
  });
});
