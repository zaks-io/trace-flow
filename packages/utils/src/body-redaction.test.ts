import { describe, expect, it } from 'vitest';
import { redactBody } from './body-redaction';
import { redactText } from './redaction';

describe('redactBody', () => {
  it('keeps JSON numbers intact so stored bodies stay valid JSON', () => {
    const body =
      '{"id":"chatcmpl-1","created":1727100000,"created_ms":1727100000000,"usage":{"prompt_tokens":12}}';
    expect(redactBody(body)).toBe(body);
    expect(() => JSON.parse(redactBody(body))).not.toThrow();
  });

  it('redacts PII inside JSON string values', () => {
    const body = '{"messages":[{"role":"user","content":"mail me at a@b.co or 415-555-0100"}]}';
    const out = redactBody(body);
    expect(JSON.parse(out)).toEqual({
      messages: [{ role: 'user', content: 'mail me at [REDACTED] or [REDACTED]' }],
    });
  });

  it('redacts values of credential-like keys', () => {
    const out = redactBody('{"api_key": "sk-live-abc", "model": "gpt-4o"}');
    expect(JSON.parse(out)).toEqual({ api_key: '[REDACTED]', model: 'gpt-4o' });
  });

  it('redacts credentials inside JSON-encoded tool arguments', () => {
    const body = JSON.stringify({ arguments: JSON.stringify({ password: 'hunter2' }) });
    const out = JSON.parse(redactBody(body)) as { arguments: string };
    expect(JSON.parse(out.arguments)).toEqual({ password: '[REDACTED]' });
  });

  it('leaves untouched string literals byte-identical, including escapes', () => {
    const body = '{"url":"https:\\/\\/example.com","name":"caf\\u00e9"}';
    expect(redactBody(body)).toBe(body);
  });

  it('re-encodes a redacted literal as valid JSON when it contained escapes', () => {
    const body = '{"content":"line one\\nemail a@b.co\\ttab"}';
    const out = JSON.parse(redactBody(body)) as { content: string };
    expect(out.content).toBe('line one\nemail [REDACTED]\ttab');
  });

  it('redacts per SSE data line and keeps SSE framing', () => {
    const body =
      'event: message_start\ndata: {"type":"message_start","message":{"created":1727100000}}\n\n' +
      'data: {"delta":{"content":"a@b.co"}}\r\n\r\ndata: [DONE]\n\n';
    expect(redactBody(body)).toBe(
      'event: message_start\ndata: {"type":"message_start","message":{"created":1727100000}}\n\n' +
        'data: {"delta":{"content":"[REDACTED]"}}\r\n\r\ndata: [DONE]\n\n',
    );
  });

  it('keeps large numeric arrays unchanged', () => {
    const embedding = Array.from({ length: 50_000 }, (_, i) => (i * 0.000137).toFixed(9));
    const body = `{"data":[{"embedding":[${embedding.join(',')}]}]}`;
    expect(redactBody(body)).toBe(body);
  });

  it('falls back to full-text redaction for a truncated JSON tail', () => {
    const out = redactBody('{"content":"ok","other":"a@b.co and more');
    expect(out).toBe('{"content":"ok","other":"[REDACTED] and more');
  });

  it('redacts card numbers stored as native JSON numbers and keeps the JSON valid', () => {
    const body = '{"type":"tool_use","input":{"card":4111111111111111,"ts":1727100000000}}';
    expect(JSON.parse(redactBody(body))).toEqual({
      type: 'tool_use',
      input: { card: '[REDACTED]', ts: 1727100000000 },
    });
  });

  it('falls back to full-text redaction when text between literals is not JSON', () => {
    expect(redactBody('{"note":"x"} 123-45-6789 10.1.2.3 415-555-0100')).toBe(
      '{"note":"x"} [REDACTED] [REDACTED] [REDACTED]',
    );
    expect(redactBody('{"a":"b", 4111 1111 1111 1111')).not.toContain('4111');
  });

  it('falls back to full-text redaction for non-JSON segments between literals', () => {
    expect(redactBody('{key: a@b.co, "x": "y"}')).toBe('{key: [REDACTED], "x": "y"}');
  });

  it('uses plain-text redaction for non-JSON bodies', () => {
    expect(redactBody('contact a@b.co')).toBe('contact [REDACTED]');
    expect(redactBody('')).toBe('');
  });
});

describe('redactText phone numbers', () => {
  it('does not treat bare ten-digit runs as phone numbers', () => {
    expect(redactText('gen-1727100000-AbCd')).toBe('gen-1727100000-AbCd');
    expect(redactText('ts 1727100000')).toBe('ts 1727100000');
  });

  it('still redacts formatted and +1-prefixed numbers', () => {
    expect(redactText('call +14155550100')).toBe('call [REDACTED]');
    expect(redactText('call 415-5550100')).toBe('call [REDACTED]');
    expect(redactText('call (415) 5550100')).toBe('call [REDACTED]');
    expect(redactText('call +1 415 555 0100')).toBe('call [REDACTED]');
    expect(redactText('call 415.555.0100')).toBe('call [REDACTED]');
  });
});
