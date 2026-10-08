import { describe, expect, it } from 'vitest';
import { tinybirdWriteTargets } from '../batcher';

describe('Tinybird trace write targets', () => {
  it('keeps the clean default without requiring a legacy datasource', () => {
    expect(tinybirdWriteTargets({})).toEqual([
      { datasource: 'otel_trace_spans', sentColumn: 'clean_sent_at_ms' },
    ]);
    expect(tinybirdWriteTargets({ TINYBIRD_DATASOURCE: 'custom_clean' })).toEqual([
      { datasource: 'custom_clean', sentColumn: 'clean_sent_at_ms' },
    ]);
  });

  it.each(['legacy', 'dual'])('requires an explicit datasource in %s mode', (mode) => {
    for (const datasource of [undefined, '', '   ']) {
      expect(() =>
        tinybirdWriteTargets({
          TINYBIRD_TRACE_WRITE_MODE: mode,
          TINYBIRD_LEGACY_DATASOURCE: datasource,
        }),
      ).toThrow(`TINYBIRD_LEGACY_DATASOURCE is required for ${mode} write mode`);
    }
  });

  it('preserves legacy and dual sent-state targets with explicit configuration', () => {
    const env = { TINYBIRD_LEGACY_DATASOURCE: 'rollback_traces' };
    const legacy = { datasource: 'rollback_traces', sentColumn: 'legacy_sent_at_ms' };
    const clean = { datasource: 'otel_trace_spans', sentColumn: 'clean_sent_at_ms' };

    expect(tinybirdWriteTargets({ ...env, TINYBIRD_TRACE_WRITE_MODE: 'legacy' })).toEqual([legacy]);
    expect(tinybirdWriteTargets({ ...env, TINYBIRD_TRACE_WRITE_MODE: 'dual' })).toEqual([
      legacy,
      clean,
    ]);
    expect(
      tinybirdWriteTargets({
        TINYBIRD_TRACE_WRITE_MODE: 'dual',
        TINYBIRD_LEGACY_DATASOURCE: 'otel_trace_spans',
      }),
    ).toEqual([clean]);
  });

  it.each(['unknown', '', 'CLEAN'])('rejects unrecognised mode %j', (mode) => {
    expect(() => tinybirdWriteTargets({ TINYBIRD_TRACE_WRITE_MODE: mode })).toThrow(
      `invalid TINYBIRD_TRACE_WRITE_MODE: ${mode}`,
    );
  });
});
