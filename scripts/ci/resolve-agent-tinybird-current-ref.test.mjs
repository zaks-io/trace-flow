import { describe, expect, test } from 'bun:test';
import {
  AGENT_TINYBIRD_DEPLOYMENT_TASK,
  resolveAgentTinybirdCurrentRef,
} from './resolve-agent-tinybird-current-ref.mjs';

const INITIAL = '844d8f0313af18ac73ad60bdbe7f81dc3d8f019d';
const DEPLOYED = '1111111111111111111111111111111111111111';
const MANUAL = '2222222222222222222222222222222222222222';

function gitFixture(contentsByRef) {
  return (args) => {
    if (args[0] === 'rev-parse') {
      const ref = args[2].replace(/\^\{commit\}$/, '');
      if (!contentsByRef[ref]) throw new Error(`unknown ref ${ref}`);
      return `${ref}\n`;
    }
    if (args[0] === 'ls-tree') {
      return ['pipes/agent_usage.pipe', 'pipes/legacy_copy.pipe', 'pipes/repair.pipe'].join('\n');
    }
    if (args[0] === 'show') {
      const [ref, path] = args[1].split(':');
      if (path === 'pipes/legacy_copy.pipe') return 'NODE only\nSQL select 1\n';
      if (path === 'pipes/repair.pipe') return 'TYPE COPY\nTARGET_DATASOURCE target\n';
      return contentsByRef[ref];
    }
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
}

function fetchFixture({
  deployments = [],
  statuses = {},
  live = 'NODE endpoint\nSQL select 1\n',
} = {}) {
  const calls = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    calls.push({ url, authorization: init.headers.Authorization });
    if (url.hostname === 'api.github.com') {
      const status = /\/deployments\/(\d+)\/statuses$/.exec(url.pathname);
      return Response.json(status ? (statuses[status[1]] ?? []) : deployments);
    }
    return Response.json({ pipes: [{ name: 'agent_usage', content: live }] });
  };
  return { calls, fetchImpl };
}

function options(fetchImpl, git, extra = {}) {
  return {
    fetchImpl,
    git,
    repository: 'zaks-io/trace-flow',
    githubToken: 'github-secret',
    tinybirdHost: 'https://api.tinybird.test',
    tinybirdToken: 'tinybird-secret',
    ...extra,
  };
}

describe('Agent Tinybird current ref resolution', () => {
  test('bootstraps from the pinned live commit and excludes Copy pipes', async () => {
    const { calls, fetchImpl } = fetchFixture();
    const result = await resolveAgentTinybirdCurrentRef(
      options(fetchImpl, gitFixture({ [INITIAL]: 'NODE endpoint\nSQL select 1\n' })),
    );

    expect(result).toMatchObject({ ref: INITIAL, source: 'initial migration pin', pipeCount: 1 });
    expect(result.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(calls[0].url.pathname).toBe('/repos/zaks-io/trace-flow/deployments');
    expect(calls[0].url.searchParams.get('task')).toBe(AGENT_TINYBIRD_DEPLOYMENT_TASK);
    expect(calls.at(-1).url.pathname).toBe('/v0/pipes');
    expect(calls.at(-1).url.searchParams.get('attrs')).toBe('name,content');
  });

  test('uses the newest successful dedicated deployment and verifies its live definitions', async () => {
    const { fetchImpl } = fetchFixture({
      deployments: [
        { id: 30, task: AGENT_TINYBIRD_DEPLOYMENT_TASK, sha: MANUAL },
        { id: 20, task: 'deploy', sha: MANUAL },
        { id: 10, task: AGENT_TINYBIRD_DEPLOYMENT_TASK, sha: DEPLOYED },
      ],
      statuses: { 30: [{ state: 'failure' }], 10: [{ state: 'success' }] },
      live: 'NODE endpoint\nSQL select 2\n',
    });
    const result = await resolveAgentTinybirdCurrentRef(
      options(
        fetchImpl,
        gitFixture({
          [INITIAL]: 'NODE endpoint\nSQL select 1\n',
          [DEPLOYED]: 'NODE endpoint\nSQL select 2\n',
        }),
      ),
    );

    expect(result).toMatchObject({
      ref: DEPLOYED,
      source: 'successful GitHub deployment',
      pipeCount: 1,
    });
  });

  test('manual recovery ref bypasses marker lookup but still requires live parity', async () => {
    const { calls, fetchImpl } = fetchFixture({ live: 'NODE endpoint\nSQL select 3\n' });
    const result = await resolveAgentTinybirdCurrentRef(
      options(fetchImpl, gitFixture({ [MANUAL]: 'NODE endpoint\nSQL select 3\n' }), {
        requestedRef: MANUAL,
      }),
    );

    expect(result).toMatchObject({ ref: MANUAL, source: 'manual input' });
    expect(calls.map(({ url }) => url.hostname)).toEqual(['api.tinybird.test']);
  });

  test('fails closed when the nominated commit does not match a live endpoint', async () => {
    const { fetchImpl } = fetchFixture({ live: 'NODE endpoint\nSQL select changed\n' });
    await expect(
      resolveAgentTinybirdCurrentRef(
        options(fetchImpl, gitFixture({ [INITIAL]: 'NODE endpoint\nSQL select 1\n' })),
      ),
    ).rejects.toThrow('Live Tinybird endpoint differs from candidate pipe agent_usage');
  });

  test('fails closed when a successful marker has no exact commit SHA', async () => {
    const { fetchImpl } = fetchFixture({
      deployments: [{ id: 10, task: AGENT_TINYBIRD_DEPLOYMENT_TASK, sha: 'main' }],
      statuses: { 10: [{ state: 'success' }] },
    });
    await expect(
      resolveAgentTinybirdCurrentRef(
        options(fetchImpl, gitFixture({ [INITIAL]: 'NODE endpoint\nSQL select 1\n' })),
      ),
    ).rejects.toThrow('Successful Agent Tinybird deployment has no exact commit SHA');
  });
});
