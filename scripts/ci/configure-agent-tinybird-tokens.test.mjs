import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
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

test('creates missing least-privilege tokens without exposing the deploy token', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-tokens-'));
  directories.push(directory);
  const output = join(directory, 'worker.env');
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({
      url: String(url),
      method: init.method ?? 'GET',
      body: init.body?.toString(),
      authorization: init.headers.Authorization,
    });
    if (String(url).endsWith('/v0/tokens')) return Response.json({ tokens: [] });
    const name = new URLSearchParams(init.body).get('name');
    return Response.json({ name, scopes: [], token: `p.${name}` });
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
    expect(calls).toEqual(['GET']);
  });
});
