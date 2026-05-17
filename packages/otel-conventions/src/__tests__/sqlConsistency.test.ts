import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_ATTRIBUTE_KEYS } from '../keys';
import { BAGGAGE_PREFIX } from '../attributes/baggage';

/**
 * Line of defense against silent drift between TypeScript attribute constants
 * and Tinybird `.pipe` / `.datasource` SQL strings. ClickHouse extracts
 * attributes by literal string key — a TS rename without a SQL update would
 * silently break the materialized view, and this test catches that.
 *
 * The test scans every `JSONExtract*(SpanAttributes, '...')` call in the
 * pipes/datasources tree and asserts each key is in `ALL_ATTRIBUTE_KEYS`
 * (or has the `baggage.` prefix, which is caller-controlled).
 */

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');

function findFilesRecursive(dir: string, suffixes: string[]): string[] {
  const out: string[] = [];
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const s = statSync(full);
      if (s.isDirectory()) {
        out.push(...findFilesRecursive(full, suffixes));
      } else if (suffixes.some((suf) => entry.endsWith(suf))) {
        out.push(full);
      }
    }
  } catch {
    // dir missing — skip silently
  }
  return out;
}

const SQL_EXTRACT_PATTERN = /JSONExtract\w+\(SpanAttributes,\s*'([^']+)'/g;

describe('SpanAttributes SQL ↔ TS constant consistency', () => {
  const files = [
    ...findFilesRecursive(join(REPO_ROOT, 'pipes'), ['.pipe']),
    ...findFilesRecursive(join(REPO_ROOT, 'datasources'), ['.datasource']),
  ];

  it('finds at least some pipe files to scan', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  const knownKeys = new Set(ALL_ATTRIBUTE_KEYS);

  for (const file of files) {
    const content = readFileSync(file, 'utf-8');
    const matches = [...content.matchAll(SQL_EXTRACT_PATTERN)];
    if (matches.length === 0) continue;

    it(`every SpanAttributes key in ${file.slice(REPO_ROOT.length + 1)} has a TS constant`, () => {
      const unknown: string[] = [];
      for (const m of matches) {
        const key = m[1];
        if (!key) continue;
        if (key.startsWith(BAGGAGE_PREFIX)) continue;
        if (!knownKeys.has(key)) unknown.push(key);
      }
      expect(unknown, `Unknown SpanAttributes keys: ${unknown.join(', ')}`).toEqual([]);
    });
  }
});
