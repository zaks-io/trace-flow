import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PARENT_DATASOURCE_PATHS = [
  'datasources/agent_message_facts.datasource',
  'datasources/agent_message_fact_versions.datasource',
];

const PARENT_COLUMNS = ['parent_vendor_session_id', 'parent_session_pk'];
const ADDED_TOKEN = 'TOKEN trace_flow_agent_facts_append APPEND\n';

function schemaColumns(contents, path) {
  const match = contents.match(/\nSCHEMA >\n([\s\S]+?)\n\n(?:FORWARD_QUERY >|ENGINE )/);
  if (!match) throw new Error(`${path}: expected one SCHEMA block`);
  const columns = [...match[1].matchAll(/^    `([^`]+)` /gm)].map((entry) => entry[1]);
  if (columns.length !== match[1].trimEnd().split('\n').length) {
    throw new Error(`${path}: unsupported SCHEMA layout`);
  }
  return columns;
}

export function planAgentMessageParentOverlay(path, current, repo) {
  if (!PARENT_DATASOURCE_PATHS.includes(path)) {
    throw new Error(`${path}: parent overlay is not allowlisted`);
  }
  if (/^FORWARD_QUERY >/m.test(repo)) {
    throw new Error(`${path}: parent overlay must not add a FORWARD_QUERY`);
  }
  if (current === repo) return 'identical';

  const currentColumns = schemaColumns(current, path);
  const repoColumns = schemaColumns(repo, path);
  const existingParents = PARENT_COLUMNS.filter((column) => currentColumns.includes(column));
  if (existingParents.length) {
    throw new Error(`${path}: current schema already has parent columns but differs from repo`);
  }
  if (repoColumns.join('\0') !== [...currentColumns, ...PARENT_COLUMNS].join('\0')) {
    throw new Error(`${path}: parent columns must be the only schema additions, at the end`);
  }

  const oldEnding = '    `cost_usd` Nullable(Float64) `json:$.cost_usd`\n';
  const newEnding =
    '    `cost_usd` Nullable(Float64) `json:$.cost_usd`,\n' +
    "    `parent_vendor_session_id` String DEFAULT '' `json:$.parent_vendor_session_id`,\n" +
    "    `parent_session_pk` String DEFAULT '' `json:$.parent_session_pk`\n";
  if (repo.split(newEnding).length !== 2) {
    throw new Error(
      `${path}: parent columns must be appended once with empty defaults and JSON paths`,
    );
  }
  let normalized = repo.replace(newEnding, oldEnding);
  if (!current.includes(ADDED_TOKEN)) {
    if (normalized.split(ADDED_TOKEN).length !== 2) {
      throw new Error(`${path}: expected one Agent append token addition`);
    }
    normalized = normalized.replace(ADDED_TOKEN, '');
  }
  if (normalized !== current) {
    throw new Error(`${path}: non-parent datasource definition changed`);
  }
  return 'additive';
}

async function applyOverlay(root, deployRoot, currentRef) {
  for (const path of PARENT_DATASOURCE_PATHS) {
    const present = execFileSync('git', ['ls-tree', '-r', '--name-only', currentRef, '--', path], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (!present) continue;
    if (present !== path) throw new Error(`${path}: unexpected current-ref tree entry`);
    const current = execFileSync('git', ['show', `${currentRef}:${path}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const repo = await readFile(join(root, path), 'utf8');
    const result = planAgentMessageParentOverlay(path, current, repo);
    if (result === 'additive') await writeFile(join(deployRoot, path), repo);
    console.log(`Validated ${path} parent columns (${result}).`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv.length !== 5) {
    throw new Error(
      'Use overlay-agent-message-parent-columns.mjs <repo-root> <deploy-root> <current-ref>',
    );
  }
  await applyOverlay(process.argv[2], process.argv[3], process.argv[4]);
}
