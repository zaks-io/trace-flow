import { chmod, writeFile } from 'node:fs/promises';

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
      ...SNAPSHOT_DATASOURCES.map((name) => `PIPES:READ:repair_${name}`),
    ],
  },
];

function required(value, name) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function normalizedScopes(scopes) {
  return scopes.map((scope) => `${scope.type}${scope.resource ? `:${scope.resource}` : ''}`).sort();
}

async function request(fetchImpl, host, deployToken, path, init = {}) {
  const response = await fetchImpl(new URL(path, host), {
    ...init,
    headers: {
      Authorization: `Bearer ${deployToken}`,
      ...(init.body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`Tinybird Token API request failed: HTTP ${response.status}`);
  return body;
}

function tokenForm(definition) {
  const form = new URLSearchParams({ name: definition.name });
  for (const scope of definition.scopes) form.append('scope', scope);
  return form;
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
    let token = matches[0];
    if (!token) {
      token = await request(fetchImpl, host, deployToken, '/v0/tokens/', {
        method: 'POST',
        body: tokenForm(definition),
      });
    } else if (
      JSON.stringify(normalizedScopes(token.scopes ?? [])) !==
      JSON.stringify([...definition.scopes].sort())
    ) {
      await request(fetchImpl, host, deployToken, `/v0/tokens/${encodeURIComponent(token.token)}`, {
        method: 'PUT',
        body: tokenForm(definition),
      });
    }
    if (typeof token.token !== 'string' || token.token.length === 0 || /[\r\n]/.test(token.token)) {
      throw new Error(`Tinybird returned an invalid value for ${definition.name}`);
    }
    values.push(`${definition.variable}=${token.token}`);
  }

  await writeFile(outputPath, `${values.join('\n')}\n`, { mode: 0o600 });
  await chmod(outputPath, 0o600);
}

if (import.meta.main) {
  await configureAgentTinybirdTokens(process.argv[2]);
  console.log('Configured scoped Agent Tinybird tokens.');
}
