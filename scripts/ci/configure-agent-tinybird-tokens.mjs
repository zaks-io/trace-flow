import { chmod, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
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

export const AGENT_SNAPSHOT_JOBS_TOKEN = {
  name: 'trace_flow_agent_snapshot_jobs',
  variable: 'TINYBIRD_AGENT_SNAPSHOT_JOBS_TOKEN',
  scopes: ['DATASOURCES:CREATE'],
};

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
      ...init.headers,
    },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`Tinybird Token API request failed: HTTP ${response.status}`);
  return body;
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

  // Tinybird forbids operational scopes on deployment-managed resource tokens.
  const jobsDefinition = AGENT_SNAPSHOT_JOBS_TOKEN;
  const jobsMatches = listing.tokens.filter((token) => token.name === jobsDefinition.name);
  if (jobsMatches.length > 1) throw new Error('Duplicate snapshot Jobs API token');
  let jobsToken = jobsMatches[0];
  if (!jobsToken) {
    await request(fetchImpl, host, deployToken, '/v0/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ name: jobsDefinition.name, scope: 'DATASOURCES:CREATE' }),
    });
    jobsToken = await request(fetchImpl, host, deployToken, `/v0/tokens/${jobsDefinition.name}`);
  }
  if (
    JSON.stringify(normalizedScopes(jobsToken.scopes ?? [])) !==
      JSON.stringify(jobsDefinition.scopes) ||
    typeof jobsToken.token !== 'string' ||
    !jobsToken.token ||
    /[\r\n]/.test(jobsToken.token)
  )
    throw new Error('Invalid snapshot Jobs API token or scopes');
  values.push(`${jobsDefinition.variable}=${jobsToken.token}`);

  await writeFile(outputPath, `${values.join('\n')}\n`, { mode: 0o600 });
  await chmod(outputPath, 0o600);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await configureAgentTinybirdTokens(process.argv[2]);
  console.log('Exported deployed Agent Tinybird tokens.');
}
