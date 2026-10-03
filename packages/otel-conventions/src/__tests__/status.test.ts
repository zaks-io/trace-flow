import { describe, expect, it } from 'vitest';
import { STATUS_CODE, isErrorStatus, normalizeSpanStatus, statusLabel } from '../index';

describe('normalizeSpanStatus', () => {
  it('maps stored OTel proto names', () => {
    expect(normalizeSpanStatus(STATUS_CODE.OK)).toBe('ok');
    expect(normalizeSpanStatus(STATUS_CODE.ERROR)).toBe('error');
    expect(normalizeSpanStatus(STATUS_CODE.UNSET)).toBe('unset');
  });

  it('maps bare names regardless of case', () => {
    expect(normalizeSpanStatus('OK')).toBe('ok');
    expect(normalizeSpanStatus('error')).toBe('error');
    expect(normalizeSpanStatus('Unset')).toBe('unset');
    expect(normalizeSpanStatus('status_code_error')).toBe('error');
  });

  it('treats a missing status as unset', () => {
    expect(normalizeSpanStatus('')).toBe('unset');
    expect(normalizeSpanStatus(undefined)).toBe('unset');
    expect(normalizeSpanStatus(null)).toBe('unset');
  });

  it('throws on unrecognised values instead of hiding them', () => {
    expect(() => normalizeSpanStatus('STATUS_CODE_EROR')).toThrow(
      'Unexpected span status code: "STATUS_CODE_EROR"',
    );
    expect(() => normalizeSpanStatus('200')).toThrow('"200"');
    expect(() => normalizeSpanStatus('STATUS_CODE_')).toThrow();
    expect(() => normalizeSpanStatus(2)).toThrow('2');
  });
});

describe('isErrorStatus', () => {
  it('is true only for error statuses', () => {
    expect(isErrorStatus(STATUS_CODE.ERROR)).toBe(true);
    expect(isErrorStatus('ERROR')).toBe(true);
    expect(isErrorStatus(STATUS_CODE.OK)).toBe(false);
    expect(isErrorStatus(STATUS_CODE.UNSET)).toBe(false);
    expect(isErrorStatus(undefined)).toBe(false);
  });

  it('throws rather than treating a malformed error status as healthy', () => {
    expect(() => isErrorStatus('STATUS_CODE_EROR')).toThrow();
  });
});

describe('statusLabel', () => {
  it('returns user-facing labels instead of proto names', () => {
    expect(statusLabel(STATUS_CODE.OK)).toBe('OK');
    expect(statusLabel(STATUS_CODE.ERROR)).toBe('Error');
    expect(statusLabel(STATUS_CODE.UNSET)).toBe('Unset');
  });
});
