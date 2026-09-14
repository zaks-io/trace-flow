import { readdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_TINYBIRD_TOKENS } from './configure-agent-tinybird-tokens.mjs';

const RESOURCE_DIRECTORIES = ['datasources', 'pipes', 'materializations', 'copies'];

async function datafilesIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await datafilesIn(path)));
    else if (entry.isFile() && ['.datasource', '.pipe'].includes(extname(entry.name)))
      files.push(path);
  }
  return files;
}

function parseScope(scope) {
  const [kind, permission, ...resourceParts] = scope.split(':');
  const resource = resourceParts.join(':');
  if (!resource || !['DATASOURCES', 'PIPES'].includes(kind)) {
    throw new Error(`Unsupported Agent Tinybird token scope ${scope}`);
  }
  return { kind, permission, resource };
}

function scopeForDirective(path, permission) {
  const extension = extname(path);
  const resource = parse(path).name;
  if (extension === '.datasource' && ['READ', 'APPEND'].includes(permission)) {
    return `DATASOURCES:${permission}:${resource}`;
  }
  if (extension === '.pipe' && permission === 'READ') return `PIPES:READ:${resource}`;
  return undefined;
}

function tokenDirectives(contents, tokenName) {
  const escapedName = tokenName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^TOKEN\\s+(?:"${escapedName}"|${escapedName})\\s+(\\S+)\\s*$`);
  return contents
    .split('\n')
    .map((line) => line.match(pattern)?.[1])
    .filter(Boolean);
}

async function resourcePath(rootPath, scope) {
  const { kind, resource } = parseScope(scope);
  const extension = kind === 'DATASOURCES' ? '.datasource' : '.pipe';
  const directories =
    kind === 'DATASOURCES' ? ['datasources'] : ['pipes', 'materializations', 'copies'];
  const matches = [];
  for (const directory of directories) {
    const path = join(rootPath, directory, `${resource}${extension}`);
    try {
      await readFile(path, 'utf8');
      matches.push(path);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (matches.length !== 1) {
    throw new Error(`Expected one datafile for ${scope}, found ${matches.length}`);
  }
  return matches[0];
}

export async function validateAgentTinybirdTokenDatafiles(rootPath) {
  if (!rootPath) throw new Error('datafile root is required');
  const tokenNames = new Set(AGENT_TINYBIRD_TOKENS.map(({ name }) => name));
  const inventory = new Map(AGENT_TINYBIRD_TOKENS.map(({ name }) => [name, []]));
  const paths = (
    await Promise.all(
      RESOURCE_DIRECTORIES.map((directory) => datafilesIn(join(rootPath, directory))),
    )
  ).flat();

  for (const path of paths) {
    const contents = await readFile(path, 'utf8');
    for (const line of contents.split('\n')) {
      const directive = line.match(/^TOKEN\s+(?:"([^"]+)"|(\S+))\s+(\S+)\s*$/);
      const tokenName = directive?.[1] ?? directive?.[2];
      if (!tokenName || !tokenNames.has(tokenName)) continue;
      const scope = scopeForDirective(path, directive[3]);
      if (!scope) throw new Error(`Invalid ${tokenName} directive in ${path}`);
      inventory.get(tokenName).push(scope);
    }
  }

  for (const definition of AGENT_TINYBIRD_TOKENS) {
    const actual = inventory.get(definition.name).sort();
    const expected = [...definition.scopes].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`Tinybird datafiles do not declare the exact scopes for ${definition.name}`);
    }
  }

  return Object.fromEntries(inventory);
}

export async function ensureAgentTinybirdTokenDatafiles(rootPath) {
  if (!rootPath) throw new Error('datafile root is required');
  let added = 0;
  let present = 0;
  for (const definition of AGENT_TINYBIRD_TOKENS) {
    for (const scope of definition.scopes) {
      const { permission } = parseScope(scope);
      const path = await resourcePath(rootPath, scope);
      const contents = await readFile(path, 'utf8');
      const directives = tokenDirectives(contents, definition.name);
      if (directives.length > 1 || (directives.length === 1 && directives[0] !== permission)) {
        throw new Error(`Invalid ${definition.name} directive in ${path}`);
      }
      if (directives.length === 1) {
        present += 1;
        continue;
      }

      const directive = `TOKEN ${definition.name} ${permission}`;
      const separator = contents.endsWith('\n') ? '' : '\n';
      await writeFile(path, `${contents}${separator}${directive}\n`);
      added += 1;
    }
  }
  await validateAgentTinybirdTokenDatafiles(rootPath);
  return { added, present };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv[2] === '--ensure-datafiles') {
    const result = await ensureAgentTinybirdTokenDatafiles(process.argv[3]);
    console.log(
      `Verified declarative Agent Tinybird token scopes (${result.added} added, ${result.present} already present).`,
    );
  } else if (process.argv[2] === '--validate-datafiles') {
    await validateAgentTinybirdTokenDatafiles(process.argv[3]);
    console.log('Validated declarative Agent Tinybird token scopes.');
  } else {
    throw new Error('Use --ensure-datafiles or --validate-datafiles');
  }
}
