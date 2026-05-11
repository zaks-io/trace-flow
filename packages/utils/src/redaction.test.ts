import { describe, it, expect } from 'vitest';
import { redactText, redactValue, luhnValid } from './redaction';

describe('luhnValid', () => {
  it('accepts common test PAN', () => {
    expect(luhnValid('4242424242424242')).toBe(true);
  });

  it('rejects invalid checksum', () => {
    expect(luhnValid('4242424242424243')).toBe(false);
  });

  it('rejects wrong length', () => {
    expect(luhnValid('424242424242')).toBe(false);
  });
});

describe('redactText', () => {
  it('redacts email', () => {
    expect(redactText('mail me at user@example.com thanks')).toBe('mail me at [REDACTED] thanks');
  });

  it('redacts SSN', () => {
    expect(redactText('id 123-45-6789 end')).toBe('id [REDACTED] end');
  });

  it('redacts IPv4', () => {
    expect(redactText('host 10.0.0.1')).toBe('host [REDACTED]');
  });

  it('redacts US phone', () => {
    expect(redactText('call 415-555-0100')).toBe('call [REDACTED]');
    expect(redactText('call (415) 555-0100')).toBe('call [REDACTED]');
  });

  it('redacts Luhn-valid card numbers', () => {
    const pan = '4242424242424242';
    expect(redactText(`card ${pan}`)).toBe('card [REDACTED]');
    expect(
      redactText(`card ${pan.slice(0, 4)}-${pan.slice(4, 8)}-${pan.slice(8, 12)}-${pan.slice(12)}`),
    ).toBe('card [REDACTED]');
  });

  it('does not redact non-Luhn digit runs', () => {
    expect(redactText('id 12345678901234')).toBe('id 12345678901234');
  });

  it('redacts Bearer tokens', () => {
    expect(redactText('Authorization: Bearer sk_live_abc123')).toBe(
      'Authorization: Bearer [REDACTED]',
    );
  });

  it('redacts Bearer tokens with base64 padding', () => {
    expect(redactText('Authorization: Bearer sk_live_abc==')).toBe(
      'Authorization: Bearer [REDACTED]',
    );
    expect(redactText('Bearer tok==')).toBe('Bearer [REDACTED]');
  });

  it('redacts sensitive JSON string values', () => {
    expect(redactText('{"access_token":"supersecret","x":1}')).toBe(
      '{"access_token":"[REDACTED]","x":1}',
    );
    expect(redactText('{"api_key":"k9","password":"p"}')).toBe(
      '{"api_key":"[REDACTED]","password":"[REDACTED]"}',
    );
    expect(redactText('{"x-api-key":"secret"}')).toBe('{"x-api-key":"[REDACTED]"}');
    expect(redactText('{"authorization":"Basic xyz"}')).toBe('{"authorization":"[REDACTED]"}');
  });

  it('returns empty string unchanged', () => {
    expect(redactText('')).toBe('');
  });
});

describe('redactValue', () => {
  it('deep-redacts string leaves without mutating input', () => {
    const input = {
      nested: { email: 'a@b.co', n: 1 },
      arr: ['x@example.com'],
    };
    const copy = structuredClone(input);
    const out = redactValue(input);
    expect(input).toEqual(copy);
    expect(out).toEqual({
      nested: { email: '[REDACTED]', n: 1 },
      arr: ['[REDACTED]'],
    });
  });

  it('redacts SSE-like nested event data', () => {
    const sse = {
      messages: [
        {
          messageStart: 1,
          events: [
            { type: 'content_block_delta', timestamp: 2, data: '{"delta":{"content":"a@b.co"}}' },
          ],
        },
      ],
    };
    const out = redactValue(sse);
    const data = out.messages[0]?.events[0]?.data;
    expect(data).toBeDefined();
    expect(data).not.toContain('a@b.co');
    expect(data).toContain('[REDACTED]');
  });
});
