import { describe, expect, it } from 'vitest';
import { BASELINE_SECURITY_HEADERS, applySecurityHeaders } from './security-headers';

describe('applySecurityHeaders', () => {
  it('sets every baseline header', () => {
    const headers = new Headers();
    applySecurityHeaders(headers);

    for (const [name, value] of Object.entries(BASELINE_SECURITY_HEADERS)) {
      expect(headers.get(name)).toBe(value);
    }
  });

  it('overrides pre-existing values', () => {
    const headers = new Headers({
      'X-Frame-Options': 'SAMEORIGIN',
      'Referrer-Policy': 'no-referrer-when-downgrade',
    });
    applySecurityHeaders(headers);

    expect(headers.get('X-Frame-Options')).toBe('DENY');
    expect(headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });

  it('preserves unrelated headers', () => {
    const headers = new Headers({ 'Content-Type': 'application/json' });
    applySecurityHeaders(headers);

    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('uses HSTS with preload and two-year max-age', () => {
    expect(BASELINE_SECURITY_HEADERS['Strict-Transport-Security']).toBe(
      'max-age=63072000; includeSubDomains; preload',
    );
  });
});
