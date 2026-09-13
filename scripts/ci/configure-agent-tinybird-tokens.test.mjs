import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGENT_APPEND_DATASOURCES,
  AGENT_TINYBIRD_TOKENS,
  configureAgentTinybirdTokens,
} from './configure-agent-tinybird-tokens.mjs';

const directories = [];
afterEach(async () =>
  Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true }))),
);

function scope(value) {
  const [type, permission, ...resource] = value.split(':');
  return { type: `${type}:${permission}`, resource: resource.join(':') };
}

test('keeps the combined append token scoped to every drain and revision datasource', () => {
  expect(AGENT_APPEND_DATASOURCES).toEqual([
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
  ]);
  expect(
    AGENT_TINYBIRD_TOKENS.find(({ variable }) => variable === 'TINYBIRD_TOKEN')?.scopes,
  ).toEqual(AGENT_APPEND_DATASOURCES.map((name) => `DATASOURCES:APPEND:${name}`));
});

test('creates missing least-privilege tokens without exposing the deploy token', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-tokens-'));
  directories.push(directory);
  const output = join(directory, 'worker.env');
  const calls = [];
  const created = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({
      url: String(url),
      method: init.method ?? 'GET',
      body: init.body?.toString(),
      authorization: init.headers.Authorization,
    });
    if (String(url).endsWith('/v0/tokens')) return Response.json({ tokens: created });
    const name = new URLSearchParams(init.body).get('name');
    const token = {
      name,
      scopes: new URLSearchParams(init.body).getAll('scope').map(scope),
      token: `p.${name}`,
    };
    created.push(token);
    return Response.json(token);
  };
  await configureAgentTinybirdTokens(output, {
    fetchImpl,
    host: 'https://tinybird.test',
    deployToken: 'deploy-secret',
  });

  const contents = await readFile(output, 'utf8');
  expect(contents).not.toContain('deploy-secret');
  for (const definition of AGENT_TINYBIRD_TOKENS) {
    expect(contents).toContain(`${definition.variable}=p.${definition.name}`);
    const create = calls.find((call) => call.body?.includes(`name=${definition.name}`));
    for (const expected of definition.scopes)
      expect(create.body).toContain(`scope=${encodeURIComponent(expected)}`);
  }
  expect((await stat(output)).mode & 0o777).toBe(0o600);
});

describe('existing Tinybird tokens', () => {
  test('updates a scope mismatch while preserving the token value', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-tokens-'));
    directories.push(directory);
    const output = join(directory, 'worker.env');
    const tokens = AGENT_TINYBIRD_TOKENS.map((definition) => ({
      name: definition.name,
      token: `p.${definition.name}`,
      scopes: definition.scopes.map(scope),
    }));
    tokens[0].scopes = [{ type: 'ADMIN' }];
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method ?? 'GET' });
      if ((init.method ?? 'GET') === 'GET') return Response.json({ tokens });
      tokens[0].scopes = new URLSearchParams(init.body).getAll('scope').map(scope);
      return Response.json({});
    };
    await configureAgentTinybirdTokens(output, {
      fetchImpl,
      host: 'https://tinybird.test',
      deployToken: 'deploy-secret',
    });
    expect(calls.filter((call) => call.method === 'PUT')).toEqual([
      {
        method: 'PUT',
        url: 'https://tinybird.test/v0/tokens/p.trace_flow_agent_delivery_read',
      },
    ]);
  });

  test('does not rotate tokens whose scopes already match', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-tokens-'));
    directories.push(directory);
    const output = join(directory, 'worker.env');
    const tokens = AGENT_TINYBIRD_TOKENS.map((definition) => ({
      name: definition.name,
      token: `p.${definition.name}`,
      scopes: [...definition.scopes].reverse().map(scope),
    }));
    const calls = [];
    await configureAgentTinybirdTokens(output, {
      host: 'https://tinybird.test',
      deployToken: 'deploy-secret',
      fetchImpl: async (url, init = {}) => {
        calls.push(init.method ?? 'GET');
        return Response.json({ tokens });
      },
    });
    expect(calls).toEqual(['GET', 'GET']);
  });
});
