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

async function checkCaller(permission, actor = 'contributor', eventName = 'issues') {
  const outputs = {};
  const run = authorize(
    {
      rest: {
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
      payload: { sender: { type: actor.endsWith('[bot]') ? 'Bot' : 'User' } },
    },
    { setOutput: (key, value) => (outputs[key] = value), notice: () => {} },
  );
  return { outputs, run };
}

describe('automation caller authorization', () => {
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
