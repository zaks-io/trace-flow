import { describe, expect, test } from 'bun:test';
import { TOML } from 'bun';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../../', import.meta.url));
const configPaths = readdirSync(`${root}/apps`).flatMap((worker) =>
  readdirSync(`${root}/apps/${worker}`)
    .filter((file) => /^wrangler\.(toml|jsonc?)$/.test(file))
    .map((file) => `apps/${worker}/${file}`),
);

function bindings(path, source) {
  const parsed = path.endsWith('.toml')
    ? { config: TOML.parse(source) }
    : ts.parseConfigFileTextToJson(path, source);
  if (parsed.error) throw new Error(`Invalid config: ${path}`);
  const config = parsed.config;
  const worker = path.split('/')[1];
  return [['development (top-level)', config], ...Object.entries(config.env ?? {})].flatMap(
    ([environment, settings]) =>
      (settings.ratelimits ?? []).map(({ name, namespace_id, simple }) => ({
        worker,
        environment,
        binding: name,
        id: String(namespace_id),
        limit: simple,
      })),
  );
}

const current = configPaths.flatMap((path) =>
  bindings(path, readFileSync(`${root}/${path}`, 'utf8')),
);
const registryRows = current.map(({ worker, environment, binding, id }) =>
  [worker, environment, binding, id].join(' | '),
);

describe('Worker rate-limit namespace registry', () => {
  test('never shares a namespace across environments', () => {
    const environments = new Map();
    for (const { environment, id } of current) {
      const normalized = environment.replace(' (top-level)', '');
      const previous = environments.get(id);
      expect(previous === undefined || previous === normalized, `namespace ${id}`).toBe(true);
      environments.set(id, normalized);
    }
  });

  test('matches every configured binding exactly', () => {
    const docs = readFileSync(`${root}/specs/architecture/workers.md`, 'utf8');
    const table = docs.split('## Rate-limit namespace registry\n')[1]?.split('\n## ')[0];
    expect(table).toBeDefined();
    const rows = table
      .split('\n')
      .filter((line) => line.startsWith('|') && !/^\|\s*(Worker|[-:])/.test(line))
      .map((line) =>
        line
          .split('|')
          .slice(1, -1)
          .map((cell) => cell.trim())
          .join(' | '),
      );
    expect(rows.sort()).toEqual(registryRows.sort());
  });

  test('preserves production namespaces and limits from main', () => {
    const production = (rows) => rows.filter(({ environment }) => environment === 'production');
    const baseline = configPaths.flatMap((path) =>
      bindings(
        path,
        execFileSync('git', ['show', `origin/main:${path}`], { cwd: root, encoding: 'utf8' }),
      ),
    );
    expect(production(current)).toEqual(production(baseline));
    expect(production(current).length).toBeGreaterThan(0);
  });
});
