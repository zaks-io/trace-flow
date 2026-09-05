import { describe, expect, test } from 'bun:test';
import { YAML } from 'bun';
import { readFileSync } from 'node:fs';

function workflow(name) {
  return YAML.parse(
    readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8'),
  );
}

const claude = workflow('claude');
const authorize = new Function(
  'github',
  'context',
  'core',
  `return (async () => { ${claude.jobs.authorize.steps[0].with.script} })()`,
);

async function checkCaller(permission, actor = 'contributor', eventName = 'issues', pull = {}) {
  const outputs = {};
  const run = authorize(
    {
      rest: {
        pulls: {
          get: async ({ pull_number }) => {
            expect(pull_number).toBe(123);
            if (pull.error) throw { status: pull.error };
            return { data: { head: { repo: pull.repo } } };
          },
        },
        repos: {
          getCollaboratorPermissionLevel: async ({ username }) => {
            expect(username).toBe(actor);
            if (typeof permission === 'number') throw { status: permission };
            return { data: { permission } };
          },
        },
      },
    },
    {
      actor,
      eventName,
      repo: { owner: 'zaks-io', repo: 'trace-flow' },
      payload: {
        sender: { type: actor.endsWith('[bot]') ? 'Bot' : 'User' },
        ...pull.payload,
      },
    },
    { setOutput: (key, value) => (outputs[key] = value), notice: () => {} },
  );
  return { outputs, run };
}

describe('automation caller authorization', () => {
  const pullEvents = [
    ['issue_comment', { issue: { number: 123, pull_request: {} } }],
    ['pull_request_review', { pull_request: { number: 123 } }],
    ['pull_request_review_comment', { pull_request: { number: 123 } }],
  ];

  test.each(pullEvents)('%s refuses forks even for trusted callers', async (event, payload) => {
    for (const actor of ['maintainer', 'useotto[bot]']) {
      for (const repo of [{ full_name: 'contributor/trace-flow' }, null]) {
        const { outputs, run } = await checkCaller('admin', actor, event, { payload, repo });
        await run;
        expect(outputs.allowed).toBe('false');
      }
    }
  });

  test.each(pullEvents)('%s retains same-repo authorization', async (event, payload) => {
    for (const permission of ['admin', 'write', 'read']) {
      const { outputs, run } = await checkCaller(permission, 'maintainer', event, {
        payload,
        repo: { full_name: 'zaks-io/trace-flow' },
      });
      await run;
      expect(outputs.allowed).toBe(String(permission !== 'read'));
    }
  });

  test.each([404, 403, 500])('PR lookup failure %s fails closed', async (error) => {
    const { outputs, run } = await checkCaller('admin', 'maintainer', 'issue_comment', {
      payload: pullEvents[0][1],
      error,
    });
    await expect(run).rejects.toEqual({ status: error });
    expect(outputs.allowed).toBe('false');
  });

  test.each(['admin', 'write', 'read', 'none', 404])('permission %s', async (permission) => {
    const { outputs, run } = await checkCaller(permission);
    await run;
    expect(outputs.allowed).toBe(String(permission === 'admin' || permission === 'write'));
  });

  test.each([403, 500])('lookup failure %s fails closed', async (status) => {
    const { outputs, run } = await checkCaller(status);
    await expect(run).rejects.toEqual({ status });
    expect(outputs.allowed).toBe('false');
  });

  test.each([
    ['useotto[bot]', 'issues', true],
    ['useotto-dev[bot]', 'issues', false],
    ['useotto-dev[bot]', 'issue_comment', true],
    ['untrusted[bot]', 'issue_comment', false],
  ])('%s on %s', async (actor, event, allowed) => {
    const { outputs, run } = await checkCaller(404, actor, event);
    await run;
    expect(outputs.allowed).toBe(String(allowed));
  });

  test('every privileged reusable workflow depends on authorization', () => {
    for (const job of Object.values(claude.jobs)) {
      if (!job.uses) continue;
      expect(job.needs).toContain('authorize');
      expect(job.if).toContain("needs.authorize.outputs.allowed == 'true'");
    }
  });
});

describe('credentialed PR checks', () => {
  const preview = workflow('preview').jobs['deploy-convex'].if;
  const cloudCheck = workflow('ci').jobs['tinybird-schema-check'].steps.find(
    (step) => step.name === 'Tinybird deploy --check (trace_flow_prod)',
  ).if;

  test.each([
    ['pull_request', 'zaks-io/trace-flow', 'maintainer', 'maintainer', true],
    ['pull_request', 'contributor/trace-flow', 'contributor', 'maintainer', false],
    ['pull_request', 'zaks-io/trace-flow', 'dependabot[bot]', 'maintainer', false],
    ['pull_request', 'zaks-io/trace-flow', 'maintainer', 'dependabot[bot]', false],
  ])('%s from %s by %s rerun by %s', (event, repo, author, actor, allowed) => {
    const github = {
      event_name: event,
      repository: 'zaks-io/trace-flow',
      actor,
      event: { pull_request: { head: { repo: { full_name: repo } }, user: { login: author } } },
    };
    for (const expression of [preview, cloudCheck]) {
      expect(new Function('github', `return (${expression});`)(github)).toBe(allowed);
    }
  });

  test('main push retains the cloud schema check', () => {
    expect(new Function('github', `return (${cloudCheck});`)({ event_name: 'push' })).toBe(true);
  });
});
