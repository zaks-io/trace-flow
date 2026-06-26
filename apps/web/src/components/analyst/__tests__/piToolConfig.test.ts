import { describe, expect, it } from 'vitest';
import { Database, Terminal, Wrench } from 'lucide-react';
import { formatPiToolLabel, getPiToolConfig } from '../piToolConfig';

describe('piToolConfig', () => {
  it('gives every Pi coding-agent tool a typed icon and label', () => {
    expect(getPiToolConfig('bash').icon).toBe(Terminal);
    expect(getPiToolConfig('bash').label).toBe('Run');
    expect(getPiToolConfig('traceflow_data').icon).toBe(Database);
    expect(getPiToolConfig('traceflow_data').label).toBe('Data query');
  });

  it('uses on-brand chart palette accents, not raw tailwind colors', () => {
    expect(getPiToolConfig('read').accent).toMatch(/^text-chart-\d$/);
    expect(getPiToolConfig('traceflow_data').accent).toMatch(/^text-chart-\d$/);
  });

  it('strips a leading tool- prefix before lookup', () => {
    expect(getPiToolConfig('tool-bash').icon).toBe(Terminal);
  });

  it('falls back to a neutral default for unknown tools', () => {
    const config = getPiToolConfig('something_unknown');
    expect(config.icon).toBe(Wrench);
    expect(config.accent).toBe('text-muted-foreground');
  });

  it('builds an inline label with a basenamed path preview', () => {
    expect(formatPiToolLabel('read', '/workspace/data/usage.json')).toBe('Read · usage.json');
  });

  it('keeps command-like detail intact in the label', () => {
    expect(formatPiToolLabel('bash', 'python analyze.py')).toBe('Run · python analyze.py');
  });

  it('returns just the label when there is no detail', () => {
    expect(formatPiToolLabel('ls')).toBe('List');
  });
});
