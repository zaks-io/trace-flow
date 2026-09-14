import { chmod, readdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SNAPSHOT_DATASOURCES = [
  'agent_context_call_buckets_hourly_snapshots',
  'agent_repositories_snapshots',
  'agent_session_file_signals_snapshots',
  'agent_session_signals_snapshots',
  'agent_session_summaries_snapshots',
  'agent_tool_usage_daily_snapshots',
  'agent_tool_usage_hourly_snapshots',
  'agent_usage_daily_snapshots',
  'agent_usage_hourly_snapshots',
];

export const AGENT_APPEND_DATASOURCES = [
  'agent_messages',
  'agent_tool_events',
  'agent_file_events',
  'agent_capability_snapshots',
  'agent_pull_request_links',
  'agent_message_facts',
  'agent_tool_event_facts',
  'agent_file_event_facts',
  'agent_capability_snapshot_facts',
  'agent_pull_request_facts',
  'agent_review_unit_attributions',
  'agent_message_fact_versions',
  'agent_tool_event_fact_versions',
  'agent_file_event_fact_versions',
  'agent_capability_snapshot_fact_versions',
  'agent_pull_request_fact_versions',
  'agent_review_unit_attribution_versions',
];

export const AGENT_TINYBIRD_TOKENS = [
  {
    name: 'trace_flow_agent_delivery_read',
    variable: 'TINYBIRD_AGENT_DELIVERY_READ_TOKEN',
    scopes: ['PIPES:READ:agent_delivery_receipt', 'PIPES:READ:agent_fact_identity_day'],
  },
  {
    name: 'trace_flow_agent_snapshot_worker',
    variable: 'TINYBIRD_AGENT_SNAPSHOT_TOKEN',
    scopes: [
      'DATASOURCES:APPEND:agent_snapshot_manifest',
      'PIPES:READ:agent_snapshot_job',
      'PIPES:READ:agent_snapshot_copy_intent_jobs',
      'PIPES:READ:agent_snapshot_manifest_latest',
      ...SNAPSHOT_DATASOURCES.map((name) => `DATASOURCES:APPEND:${name}`),
      ...SNAPSHOT_DATASOURCES.map((name) => `PIPES:READ:repair_${name}`),
    ],
  },
  {
    name: 'trace_flow_agent_facts_append',
    variable: 'TINYBIRD_TOKEN',
    scopes: AGENT_APPEND_DATASOURCES.map((name) => `DATASOURCES:APPEND:${name}`),
  },
];

function required(value, name) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function normalizedScopes(scopes) {
  return scopes.map((scope) => `${scope.type}${scope.resource ? `:${scope.resource}` : ''}`).sort();
}

async function request(fetchImpl, host, deployToken, path) {
  const response = await fetchImpl(new URL(path, host), {
    headers: {
      Authorization: `Bearer ${deployToken}`,
    },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`Tinybird Token API request failed: HTTP ${response.status}`);
  return body;
}

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

function scopeForDirective(path, permission) {
  const extension = extname(path);
  const resource = parse(path).name;
  if (extension === '.datasource' && ['READ', 'APPEND'].includes(permission)) {
    return `DATASOURCES:${permission}:${resource}`;
  }
  if (extension === '.pipe' && permission === 'READ') return `PIPES:READ:${resource}`;
  return undefined;
}

export async function validateAgentTinybirdTokenDatafiles(rootPath) {
  required(rootPath, 'datafile root');
  const tokenNames = new Set(AGENT_TINYBIRD_TOKENS.map(({ name }) => name));
  const inventory = new Map(AGENT_TINYBIRD_TOKENS.map(({ name }) => [name, []]));
  const paths = (
    await Promise.all(
      ['datasources', 'pipes', 'materializations', 'copies'].map((directory) =>
        datafilesIn(join(rootPath, directory)),
      ),
    )
  ).flat();

  for (const path of paths) {
    const contents = await readFile(path, 'utf8');
    for (const line of contents.split('\n')) {
      const directive = line.match(/^TOKEN\s+(?:"([^"]+)"|(\S+))\s+(READ|APPEND)\s*$/);
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

export async function configureAgentTinybirdTokens(outputPath, options = {}) {
  required(outputPath, 'output path');
  const fetchImpl = options.fetchImpl ?? fetch;
  const host = required(options.host ?? process.env.TB_HOST, 'TB_HOST');
  const deployToken = required(options.deployToken ?? process.env.TB_TOKEN, 'TB_TOKEN');
  const listing = await request(fetchImpl, host, deployToken, '/v0/tokens');
  if (!Array.isArray(listing.tokens)) throw new Error('Tinybird Token API returned no token list');

  const values = [];
  for (const definition of AGENT_TINYBIRD_TOKENS) {
    const matches = listing.tokens.filter((token) => token.name === definition.name);
    if (matches.length > 1) throw new Error(`Tinybird returned duplicate token ${definition.name}`);
    const token = matches[0];
    if (!token) throw new Error(`Tinybird did not deploy token ${definition.name}`);
    if (
      JSON.stringify(normalizedScopes(token.scopes ?? [])) !==
      JSON.stringify([...definition.scopes].sort())
    ) {
      throw new Error(`Tinybird did not preserve the exact scopes for ${definition.name}`);
    }
    if (typeof token.token !== 'string' || token.token.length === 0 || /[\r\n]/.test(token.token)) {
      throw new Error(`Tinybird returned an invalid value for ${definition.name}`);
    }
    values.push(`${definition.variable}=${token.token}`);
  }

  await writeFile(outputPath, `${values.join('\n')}\n`, { mode: 0o600 });
  await chmod(outputPath, 0o600);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv[2] === '--validate-datafiles') {
    await validateAgentTinybirdTokenDatafiles(process.argv[3]);
    console.log('Validated declarative Agent Tinybird token scopes.');
  } else {
    await configureAgentTinybirdTokens(process.argv[2]);
    console.log('Exported deployed Agent Tinybird tokens.');
  }
}
