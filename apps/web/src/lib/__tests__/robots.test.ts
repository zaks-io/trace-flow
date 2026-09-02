import { describe, expect, it } from 'vitest';
import { buildRobotsTxt } from '../robots';

function directiveValues(name: string): string[] {
  const prefix = `${name.toLowerCase()}:`;
  return buildRobotsTxt()
    .split('\n')
    .filter((line) => line.toLowerCase().startsWith(prefix))
    .map((line) => line.slice(prefix.length).trim());
}

function parseContentSignal(): Record<string, string> {
  const [value] = directiveValues('Content-Signal');
  return Object.fromEntries(
    value.split(',').map((signal) => {
      const [key, signalValue] = signal.split('=');
      return [key.trim(), signalValue.trim()];
    }),
  );
}

describe('buildRobotsTxt', () => {
  it('declares a content signal for every preference the spec defines', () => {
    expect(parseContentSignal()).toEqual({
      'ai-train': 'no',
      search: 'yes',
      'ai-input': 'yes',
    });
  });

  it('applies the content signal to the same group that grants crawl access', () => {
    const lines = buildRobotsTxt()
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const groupStart = lines.findIndex((line) => line.toLowerCase() === 'user-agent: *');
    const signalLine = lines.findIndex((line) => line.toLowerCase().startsWith('content-signal:'));

    expect(groupStart).toBeGreaterThanOrEqual(0);
    expect(signalLine).toBe(groupStart + 1);
  });

  it('advertises the sitemap without exposing private or token-bearing routes', () => {
    expect(directiveValues('Allow')).toEqual(['/']);
    expect(directiveValues('Disallow')).toEqual([
      '/api',
      '/app',
      '/auth',
      '/invite/',
      '/waitlist/confirm/',
    ]);
    expect(directiveValues('Sitemap')).toEqual(['https://trace-flow.dev/sitemap.xml']);
  });
});
