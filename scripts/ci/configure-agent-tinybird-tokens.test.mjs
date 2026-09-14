import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  AGENT_APPEND_DATASOURCES,
  AGENT_TINYBIRD_TOKENS,
  configureAgentTinybirdTokens,
} from './configure-agent-tinybird-tokens.mjs';
import {
  ensureAgentTinybirdTokenDatafiles,
  validateAgentTinybirdTokenDatafiles,
} from './configure-agent-tinybird-tokens-datafiles.mjs';

const directories = [];
afterEach(async () =>
  Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true }))),
);

function scope(value) {
  const [type, permission, ...resource] = value.split(':');
  return { type: `${type}:${permission}`, resource: resource.join(':') };
}

function deployedTokens() {
  return AGENT_TINYBIRD_TOKENS.map((definition) => ({
    name: definition.name,
    token: `p.${definition.name}`,
    scopes: [...definition.scopes].reverse().map(scope),
  }));
}

async function outputPath() {
  const directory = await mkdtemp(join(tmpdir(), 'agent-tokens-'));
  directories.push(directory);
  return join(directory, 'worker.env');
}

function datafileForScope(root, scope) {
  const [kind, , resource] = scope.split(':');
  if (kind === 'DATASOURCES') return join(root, 'datasources', `${resource}.datasource`);
  const directory = resource.startsWith('repair_') ? 'copies' : 'pipes';
  return join(root, directory, `${resource}.pipe`);
}

async function datafileFixture(includeDeclarations = false) {
  const root = await mkdtemp(join(tmpdir(), 'agent-token-datafiles-'));
  directories.push(root);
  const expectedBase = new Map();
  for (const definition of AGENT_TINYBIRD_TOKENS) {
    for (const scopeValue of definition.scopes) {
      const [, permission] = scopeValue.split(':');
      const path = datafileForScope(root, scopeValue);
      const base = 'DESCRIPTION >\n    preserved bytes\n\nTOKEN existing_reader READ\n';
      await mkdir(dirname(path), { recursive: true });
      await writeFile(
        path,
        includeDeclarations ? `${base}TOKEN ${definition.name} ${permission}\n` : base,
      );
      expectedBase.set(path, base);
    }
  }
  return { root, expectedBase };
}

test('defines the exact deployed token names, Worker variables, and resource scopes', () => {
  expect(AGENT_TINYBIRD_TOKENS).toEqual([
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
        'DATASOURCES:APPEND:agent_context_call_buckets_hourly_snapshots',
        'DATASOURCES:APPEND:agent_repositories_snapshots',
        'DATASOURCES:APPEND:agent_session_file_signals_snapshots',
        'DATASOURCES:APPEND:agent_session_signals_snapshots',
        'DATASOURCES:APPEND:agent_session_summaries_snapshots',
        'DATASOURCES:APPEND:agent_tool_usage_daily_snapshots',
        'DATASOURCES:APPEND:agent_tool_usage_hourly_snapshots',
        'DATASOURCES:APPEND:agent_usage_daily_snapshots',
        'DATASOURCES:APPEND:agent_usage_hourly_snapshots',
        'PIPES:READ:repair_agent_context_call_buckets_hourly_snapshots',
        'PIPES:READ:repair_agent_repositories_snapshots',
        'PIPES:READ:repair_agent_session_file_signals_snapshots',
        'PIPES:READ:repair_agent_session_signals_snapshots',
        'PIPES:READ:repair_agent_session_summaries_snapshots',
        'PIPES:READ:repair_agent_tool_usage_daily_snapshots',
        'PIPES:READ:repair_agent_tool_usage_hourly_snapshots',
        'PIPES:READ:repair_agent_usage_daily_snapshots',
        'PIPES:READ:repair_agent_usage_hourly_snapshots',
      ],
    },
    {
      name: 'trace_flow_agent_facts_append',
      variable: 'TINYBIRD_TOKEN',
      scopes: AGENT_APPEND_DATASOURCES.map((name) => `DATASOURCES:APPEND:${name}`),
    },
  ]);
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
});

test('reads and exports deployed least-privilege tokens without mutation', async () => {
  const output = await outputPath();
  const calls = [];
  await configureAgentTinybirdTokens(output, {
    host: 'https://tinybird.test',
    deployToken: 'operator-secret',
    fetchImpl: async (url, init = {}) => {
      calls.push({
        url: String(url),
        method: init.method ?? 'GET',
        authorization: init.headers.Authorization,
        body: init.body,
      });
      return Response.json({ tokens: deployedTokens() });
    },
  });

  expect(calls).toEqual([
    {
      url: 'https://tinybird.test/v0/tokens',
      method: 'GET',
      authorization: 'Bearer operator-secret',
      body: undefined,
    },
  ]);
  expect(await readFile(output, 'utf8')).toBe(
    AGENT_TINYBIRD_TOKENS.map(({ name, variable }) => `${variable}=p.${name}`).join('\n') + '\n',
  );
  expect((await stat(output)).mode & 0o777).toBe(0o600);
});

test('fails without writing an export when a deployed token is missing', async () => {
  const output = await outputPath();
  const tokens = deployedTokens().slice(1);
  await expect(
    configureAgentTinybirdTokens(output, {
      host: 'https://tinybird.test',
      deployToken: 'operator-secret',
      fetchImpl: async () => Response.json({ tokens }),
    }),
  ).rejects.toThrow('Tinybird did not deploy token trace_flow_agent_delivery_read');
  await expect(readFile(output, 'utf8')).rejects.toThrow();
});

test('fails without writing an export when deployed scopes are not exact', async () => {
  const output = await outputPath();
  const tokens = deployedTokens();
  tokens[0].scopes = [{ type: 'ADMIN' }];
  await expect(
    configureAgentTinybirdTokens(output, {
      host: 'https://tinybird.test',
      deployToken: 'operator-secret',
      fetchImpl: async () => Response.json({ tokens }),
    }),
  ).rejects.toThrow(
    'Tinybird did not preserve the exact scopes for trace_flow_agent_delivery_read',
  );
  await expect(readFile(output, 'utf8')).rejects.toThrow();
});

test('adds every missing datafile binding without changing existing bytes or tokens', async () => {
  const { root, expectedBase } = await datafileFixture();
  expect(await ensureAgentTinybirdTokenDatafiles(root)).toEqual({ added: 41, present: 0 });
  const inventory = await validateAgentTinybirdTokenDatafiles(root);
  expect(inventory).toEqual(
    Object.fromEntries(AGENT_TINYBIRD_TOKENS.map(({ name, scopes }) => [name, [...scopes].sort()])),
  );
  for (const [path, base] of expectedBase) {
    const withoutAgentToken = (await readFile(path, 'utf8'))
      .split('\n')
      .filter((line) => !line.startsWith('TOKEN trace_flow_agent_'))
      .join('\n');
    expect(withoutAgentToken).toBe(base);
  }
});

test('keeps one existing exact datafile binding byte-for-byte', async () => {
  const { root, expectedBase } = await datafileFixture(true);
  const before = await Promise.all(
    [...expectedBase.keys()].map(async (path) => [path, await readFile(path, 'utf8')]),
  );
  expect(await ensureAgentTinybirdTokenDatafiles(root)).toEqual({ added: 0, present: 41 });
  for (const [path, contents] of before) expect(await readFile(path, 'utf8')).toBe(contents);
});

test('rejects a wrong datafile permission', async () => {
  const { root } = await datafileFixture();
  const path = datafileForScope(root, AGENT_TINYBIRD_TOKENS[0].scopes[0]);
  await writeFile(
    path,
    `${await readFile(path, 'utf8')}TOKEN trace_flow_agent_delivery_read APPEND\n`,
  );
  await expect(ensureAgentTinybirdTokenDatafiles(root)).rejects.toThrow(
    'Invalid trace_flow_agent_delivery_read directive',
  );
});

test('rejects duplicate datafile bindings', async () => {
  const { root } = await datafileFixture();
  const path = datafileForScope(root, AGENT_TINYBIRD_TOKENS[0].scopes[0]);
  const directive = 'TOKEN trace_flow_agent_delivery_read READ\n';
  await writeFile(path, `${await readFile(path, 'utf8')}${directive}${directive}`);
  await expect(ensureAgentTinybirdTokenDatafiles(root)).rejects.toThrow(
    'Invalid trace_flow_agent_delivery_read directive',
  );
});
