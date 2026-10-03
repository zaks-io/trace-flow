import { describe, expect, test } from 'bun:test';
import { Glob, YAML } from 'bun';
import { readFileSync } from 'node:fs';

function workflow(name) {
  return YAML.parse(
    readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8'),
  );
}

const claude = workflow('claude');
const ci = workflow('ci');
const preview = workflow('preview');
const deploy = workflow('deploy');
const authorize = new Function(
  'github',
  'context',
  'core',
  `return (async () => { ${claude.jobs.authorize.steps[0].with.script} })()`,
);

const resolvePreview = new Function(
  'github',
  'context',
  'core',
  'process',
  `return (async () => { ${preview.jobs.prepare.steps[0].with.script} })()`,
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

describe('preview credential boundary', () => {
  test('runs only through an owner-dispatched numeric PR input', () => {
    expect(preview.on.pull_request).toBeUndefined();
    expect(preview.on.workflow_dispatch.inputs.pull_request_number.type).toBe('number');

    const ownerGate = new Function('github', `return (${preview.jobs.prepare.if});`);
    expect(ownerGate({ actor: 'isuttell', triggering_actor: 'isuttell' })).toBe(true);
    expect(ownerGate({ actor: 'isuttell', triggering_actor: 'maintainer' })).toBe(false);
    expect(ownerGate({ actor: 'maintainer', triggering_actor: 'isuttell' })).toBe(false);
  });

  test('provisions the complete dev-scoped Agent Tinybird secret file', () => {
    const deployWorkers = preview.jobs.preview.steps.find(
      (step) => step.name === 'Deploy Convex-backed Preview Workers',
    );

    expect(deployWorkers.run).toContain(
      'bun scripts/ci/configure-agent-tinybird-tokens.mjs "$agent_consumer_secrets_file"',
    );
    expect(deployWorkers.run).toContain('unset TB_TOKEN');
    expect(deployWorkers.run).toContain(
      `printf 'BODY_ENCRYPTION_ROOT_KEY=%s\\n' "$AGENT_DELIVERY_ENCRYPTION_ROOT_KEY" >> "$agent_consumer_secrets_file"`,
    );
    expect(deployWorkers.env.TB_TOKEN).toBe('${{ secrets.TINYBIRD_DEV_TOKEN_MANAGER_TOKEN }}');
    expect(deployWorkers.env.TB_HOST).toBe('https://api.us-west-2.aws.tinybird.co');
    expect(deployWorkers.env).not.toHaveProperty('TINYBIRD_AGENT_DELIVERY_READ_TOKEN');
    expect(deployWorkers.env).not.toHaveProperty('TINYBIRD_AGENT_SNAPSHOT_TOKEN');
  });

  test('binds Convex JWT signing to the approved dev Tinybird workspace', async () => {
    const configure = preview.jobs['deploy-convex'].steps.find(
      (step) => step.name === 'Configure Convex query tracing',
    );
    expect(configure.env.TB_TOKEN).toBe('${{ secrets.TINYBIRD_DEV_TOKEN_MANAGER_TOKEN }}');
    expect(configure.env.TB_HOST).toBe('https://api.us-west-2.aws.tinybird.co');
    const source = configure.run.match(/node --input-type=module <<'NODE'\n([\s\S]*?)\nNODE/)[1];
    const lookup = new Function('process', 'fetch', `return (async () => { ${source} })()`);
    const output = [];
    const workspaceId = '11111111-2222-3333-4444-555555555555';
    const context = {
      env: { TB_HOST: configure.env.TB_HOST, TB_TOKEN: 'dummy-dev-admin-token' },
      stdout: { write: (value) => output.push(value) },
    };
    await lookup(context, async (url, init) => {
      expect(String(url)).toBe(`${context.env.TB_HOST}/v1/workspace`);
      expect(init.headers.Authorization).toBe(`Bearer ${context.env.TB_TOKEN}`);
      return Response.json({ name: 'trace_flow_dev', id: workspaceId });
    });
    expect(output).toEqual([workspaceId]);
    for (const workspace of [
      { name: 'trace_flow_prod', id: workspaceId },
      { name: 'trace_flow_dev', id: 'test' },
    ]) {
      await expect(lookup(context, async () => Response.json(workspace))).rejects.toThrow(
        'Preview requires the trace_flow_dev Tinybird workspace',
      );
    }
    await expect(lookup(context, async () => new Response('', { status: 403 }))).rejects.toThrow(
      'Tinybird workspace lookup failed: HTTP 403',
    );
    expect(output).toEqual([workspaceId]);
    const push = configure.run.indexOf('convex deploy --preview-name "$BRANCH_NAME"');
    for (const name of ['TINYBIRD_WORKSPACE_ID', 'TINYBIRD_API_URL', 'TINYBIRD_ADMIN_TOKEN']) {
      const set = configure.run.indexOf(`convex env set --preview-name "$BRANCH_NAME" ${name}`);
      expect(set).toBeGreaterThan(0);
      expect(set).toBeLessThan(push);
    }
    expect(configure.run).toContain(`printf '%s' "$TB_TOKEN" |`);
  });

  test('aligns Collector, key sync, and Analyst Preview authentication without production resources', () => {
    const configure = preview.jobs['deploy-convex'].steps.find(
      (step) => step.name === 'Configure Convex query tracing',
    );
    for (const name of [
      'AUTH0_CLIENT_SECRET',
      'CLOUDFLARE_ACCOUNT_ID',
      'CLOUDFLARE_API_TOKEN',
      'AGENT_INGEST_SHARED_SECRET',
      'ANALYST_SANDBOX_SHARED_SECRET',
      'USAGE_SYNC_SECRET',
    ]) {
      expect(configure.env[name]).toBe(`\${{ secrets.${name} }}`);
      expect(configure.run).toContain(name);
    }
    expect(configure.run).toContain('test -n "$value"');
    expect(configure.run).toContain(
      `printf '%s' "$value" | bunx convex env set --preview-name "$BRANCH_NAME" "$name"`,
    );
    expect(configure.run).toContain('CLOUDFLARE_KV_NAMESPACE_ID "$PREVIEW_API_KEYS_NAMESPACE_ID"');
    expect(configure.run).toContain(
      'CLOUDFLARE_COLLECTOR_CREDS_NAMESPACE_ID "$PREVIEW_COLLECTOR_CREDS_NAMESPACE_ID"',
    );
    const workers = preview.jobs.preview.steps.find(
      (step) => step.name === 'Deploy Convex-backed Preview Workers',
    );
    expect(workers.env.AGENT_INGEST_SHARED_SECRET).toBe(configure.env.AGENT_INGEST_SHARED_SECRET);
    expect(workers.run).toContain(
      `printf 'AGENT_INGEST_SHARED_SECRET=%s\\n' "$AGENT_INGEST_SHARED_SECRET" >> "$agent_ingest_secrets_file"`,
    );
    const analyst = preview.jobs.preview.steps.find(
      (step) => step.name === 'Configure Analyst Preview authentication',
    );
    expect(analyst.env.ANALYST_SANDBOX_SHARED_SECRET).toBe(
      configure.env.ANALYST_SANDBOX_SHARED_SECRET,
    );
    expect(analyst.env.OPENROUTER_API_KEY).toBe('${{ secrets.OPENROUTER_API_KEY }}');
    expect(analyst.run).toContain('test -n "$OPENROUTER_API_KEY"');
    expect(analyst.run).toContain('wrangler secret put OPENROUTER_API_KEY --env preview');
    expect(analyst.run).toContain(
      'convex env set --preview-name "$BRANCH_NAME" OPENROUTER_API_KEY',
    );
    expect(analyst.run).toContain('cd apps/analyst-sandbox');
    expect(analyst.run).not.toContain('--cwd');
    expect(analyst.run).not.toContain('--prod');
  });

  test('protects the Proxy token helper with its native Node tests in CI', () => {
    const filters = YAML.parse(
      ci.jobs.changes.steps.find((step) => step.id === 'filter').with.filters,
    );
    expect(filters.workflows).toContain('scripts/ci/configure-proxy-tinybird-token*');
    const steps = ci.jobs.actionlint.steps;
    const testIndex = steps.findIndex((step) => step.name === 'Test workflow helpers');
    expect(steps[testIndex].run).toContain(
      'node --test scripts/ci/configure-proxy-tinybird-token.test.mjs',
    );
    expect(
      steps
        .slice(0, testIndex)
        .some(
          (step) =>
            step.uses?.startsWith('actions/setup-node@') && step.with?.['node-version'] === 24,
        ),
    ).toBe(true);
  });

  test('provisions Gateway usage auth and a scoped Proxy Consumer trace append token', () => {
    const configure = preview.jobs['deploy-convex'].steps.find(
      (step) => step.name === 'Configure Convex query tracing',
    );
    const workers = preview.jobs.preview.steps.find(
      (step) => step.name === 'Deploy Convex-backed Preview Workers',
    );
    expect(workers.env.USAGE_SYNC_SECRET).toBe(configure.env.USAGE_SYNC_SECRET);
    expect(workers.env.BODY_ENCRYPTION_ROOT_KEY).toBe('${{ secrets.BODY_ENCRYPTION_ROOT_KEY }}');
    expect(workers.run).toContain(
      'cd apps/proxy && bunx wrangler deploy --env preview --secrets-file "$proxy_secrets_file"',
    );
    expect(workers.run).toContain(
      'cd apps/proxy-consumer && bunx wrangler deploy --env preview --secrets-file "$proxy_consumer_secrets_file"',
    );
    expect(workers.run).toContain(
      'node scripts/ci/configure-proxy-tinybird-token.mjs "$proxy_consumer_secrets_file"',
    );
    expect(workers.run).toContain(
      `printf 'BODY_ACCESS_JWT_SECRET=%s\\nBODY_ENCRYPTION_ROOT_KEY=%s\\n' "$BODY_ACCESS_JWT_SECRET" "$BODY_ENCRYPTION_ROOT_KEY" > "$api_secrets_file"`,
    );
    expect(workers.run).not.toContain(
      '"$BODY_ENCRYPTION_ROOT_KEY" >> "$proxy_consumer_secrets_file"',
    );
  });

  test('aligns Preview Web runtime authentication with the configured Auth0 application', () => {
    const steps = preview.jobs.preview.steps;
    const configure = steps.find((step) => step.name === 'Configure Web Preview authentication');
    expect(configure.env.AUTH0_CLIENT_ID).toBe('${{ vars.NEXT_PUBLIC_AUTH0_CLIENT_ID }}');
    expect(configure.env.AUTH0_DOMAIN).toBe('${{ vars.NEXT_PUBLIC_AUTH0_DOMAIN }}');
    const configureConvex = preview.jobs['deploy-convex'].steps.find(
      (step) => step.name === 'Configure Convex query tracing',
    );
    expect(configureConvex.env.AUTH0_CLIENT_ID).toBe(configure.env.AUTH0_CLIENT_ID);
    expect(configureConvex.env.AUTH0_DOMAIN).toBe(configure.env.AUTH0_DOMAIN);
    for (const name of ['AUTH0_CLIENT_ID', 'AUTH0_DOMAIN']) {
      const setCommand = `convex env set --preview-name "$BRANCH_NAME" ${name} "$${name}"`;
      expect(configureConvex.run).toContain(setCommand);
      expect(configureConvex.run.indexOf(setCommand)).toBeLessThan(
        configureConvex.run.indexOf('convex deploy --preview-name "$BRANCH_NAME"'),
      );
    }
    for (const name of ['AUTH0_CLIENT_SECRET', 'AUTH0_SECRET', 'BODY_ACCESS_JWT_SECRET']) {
      expect(configure.env[name]).toBe(`\${{ secrets.${name} }}`);
    }
    expect(configure.run).toContain('if (!value) throw new Error');
    expect(configure.run).toContain('wrangler secret bulk "$web_secrets_file" --env preview');
    expect(steps.indexOf(configure)).toBeLessThan(
      steps.findIndex((step) => step.name === 'Deploy Web Preview'),
    );
  });

  test('resolves an open same-repository PR to its immutable head', async () => {
    const outputs = {};
    const failures = [];
    await resolvePreview(
      {
        rest: {
          pulls: {
            get: async ({ owner, repo, pull_number }) => {
              expect({ owner, repo, pull_number }).toEqual({
                owner: 'zaks-io',
                repo: 'trace-flow',
                pull_number: 123,
              });
              return {
                data: {
                  state: 'open',
                  head: {
                    ref: 'security-fix',
                    sha: '0123456789abcdef',
                    repo: { full_name: 'zaks-io/trace-flow' },
                  },
                },
              };
            },
          },
        },
      },
      { repo: { owner: 'zaks-io', repo: 'trace-flow' } },
      {
        setFailed: (message) => failures.push(message),
        setOutput: (key, value) => (outputs[key] = value),
      },
      { env: { PR_NUMBER: '123' } },
    );

    expect(failures).toEqual([]);
    expect(outputs).toEqual({ head_ref: 'security-fix', head_sha: '0123456789abcdef' });
  });

  test.each([
    ['closed', 'zaks-io/trace-flow'],
    ['open', 'contributor/trace-flow'],
  ])('rejects a PR with state %s from %s', async (state, fullName) => {
    const outputs = {};
    const failures = [];
    await resolvePreview(
      {
        rest: {
          pulls: {
            get: async () => ({
              data: {
                state,
                head: { ref: 'unsafe', sha: 'badc0de', repo: { full_name: fullName } },
              },
            }),
          },
        },
      },
      { repo: { owner: 'zaks-io', repo: 'trace-flow' } },
      {
        setFailed: (message) => failures.push(message),
        setOutput: (key, value) => (outputs[key] = value),
      },
      { env: { PR_NUMBER: '123' } },
    );

    expect(failures).toHaveLength(1);
    expect(outputs).toEqual({});
  });

  test('credentialed jobs use the authorized SHA without checkout credentials', () => {
    for (const name of ['deploy-convex', 'preview']) {
      const job = preview.jobs[name];
      expect(job.needs).toContain('prepare');
      const checkout = job.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
      expect(checkout.with.ref).toBe('${{ needs.prepare.outputs.head_sha }}');
      expect(checkout.with['persist-credentials']).toBe(false);
    }

    expect(
      preview.jobs.comment.steps.some((step) => step.uses?.startsWith('actions/checkout@')),
    ).toBe(false);
  });

  test('pins preview Agent Ingest resources outside PR-controlled configuration', () => {
    expect(preview.env.PREVIEW_COLLECTOR_CREDS_NAMESPACE_ID).toBe(
      '422b54e456c7446ea5ba4f9ef9a8c84e',
    );
    expect(preview.env.PREVIEW_AGENT_DELIVERY_BUCKET).toBe('trace-flow-agent-deliveries-dev');

    for (const jobName of ['deploy-convex', 'preview']) {
      const steps = preview.jobs[jobName].steps;
      const verify = steps.find((step) => step.name === 'Verify Preview resource isolation');
      const installIndex = steps.findIndex((step) => step.name === 'Install dependencies');
      expect(steps.indexOf(verify)).toBeLessThan(installIndex);
      expect(verify.run).toContain('import agentIngestConfig');
      expect(verify.run).toContain('Agent Ingest Preview namespace mismatch');
      expect(verify.run).toContain('Agent delivery Preview bucket mismatch');
    }
  });

  test('executes the Preview resource isolation check against Wrangler JSONC', () => {
    const verify = preview.jobs['deploy-convex'].steps.find(
      (step) => step.name === 'Verify Preview resource isolation',
    );
    const result = Bun.spawnSync({
      cmd: ['bash', '-euo', 'pipefail', '-c', verify.run],
      cwd: new URL('../..', import.meta.url).pathname,
      env: {
        ...process.env,
        PREVIEW_API_KEYS_NAMESPACE_ID: preview.env.PREVIEW_API_KEYS_NAMESPACE_ID,
        PREVIEW_COLLECTOR_CREDS_NAMESPACE_ID: preview.env.PREVIEW_COLLECTOR_CREDS_NAMESPACE_ID,
        PREVIEW_AGENT_DELIVERY_BUCKET: preview.env.PREVIEW_AGENT_DELIVERY_BUCKET,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(result.exitCode).toBe(0);
  });

  test('fails before deploying when Preview proxy keys target another namespace', () => {
    const verify = preview.jobs['deploy-convex'].steps.find(
      (step) => step.name === 'Verify Preview resource isolation',
    );
    const result = Bun.spawnSync({
      cmd: ['bash', '-euo', 'pipefail', '-c', verify.run],
      cwd: new URL('../..', import.meta.url).pathname,
      env: {
        ...process.env,
        PREVIEW_API_KEYS_NAMESPACE_ID: 'wrong-namespace',
        PREVIEW_COLLECTOR_CREDS_NAMESPACE_ID: preview.env.PREVIEW_COLLECTOR_CREDS_NAMESPACE_ID,
        PREVIEW_AGENT_DELIVERY_BUCKET: preview.env.PREVIEW_AGENT_DELIVERY_BUCKET,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain('Proxy Preview namespace mismatch');
  });

  test('fails the Preview resource isolation check on a trusted resource mismatch', () => {
    const verify = preview.jobs['deploy-convex'].steps.find(
      (step) => step.name === 'Verify Preview resource isolation',
    );
    const result = Bun.spawnSync({
      cmd: ['bash', '-euo', 'pipefail', '-c', verify.run],
      cwd: new URL('../..', import.meta.url).pathname,
      env: {
        ...process.env,
        PREVIEW_API_KEYS_NAMESPACE_ID: preview.env.PREVIEW_API_KEYS_NAMESPACE_ID,
        PREVIEW_COLLECTOR_CREDS_NAMESPACE_ID: 'wrong-namespace',
        PREVIEW_AGENT_DELIVERY_BUCKET: preview.env.PREVIEW_AGENT_DELIVERY_BUCKET,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(result.exitCode).not.toBe(0);
  });
});

describe('credentialed CI checks', () => {
  test('Tinybird fixtures have the runtimes and workspace dependencies used by migration proofs', () => {
    const steps = ci.jobs['tinybird-schema-check'].steps;
    const fixture = steps.findIndex(
      (step) => step.name === 'Build and test against Tinybird Local',
    );
    const prerequisites = steps.slice(0, fixture);
    expect(fixture).toBeGreaterThan(0);
    expect(prerequisites.some((step) => step.uses === 'oven-sh/setup-bun@v2')).toBe(true);
    expect(
      prerequisites.some(
        (step) => step.uses === 'actions/setup-node@v6' && step.with['node-version'] === 24,
      ),
    ).toBe(true);
    const install = prerequisites.findIndex((step) => step.run === 'bun install --frozen-lockfile');
    const bun = prerequisites.findIndex((step) => step.uses === 'oven-sh/setup-bun@v2');
    expect(install).toBeGreaterThan(bun);
  });

  test('Tinybird checks run when Copy SQL or its fixtures change independently', () => {
    const filters = YAML.parse(
      ci.jobs.changes.steps.find((step) => step.id === 'filter').with.filters,
    );
    for (const path of [
      'copies/repair_agent_messages_versions_baseline.pipe',
      'fixtures/agent_message_facts.ndjson',
      'scripts/ci/tinybird-local-fixture-tests.py',
      'scripts/ci/tinybird_baseline_version_fixtures.py',
    ]) {
      expect(filters.tinybird.some((pattern) => new Glob(pattern).match(path))).toBe(true);
    }
  });

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
    expect(new Function('github', `return (${cloudCheck});`)(github)).toBe(allowed);
  });

  test('main push retains the cloud schema check', () => {
    expect(new Function('github', `return (${cloudCheck});`)({ event_name: 'push' })).toBe(true);
  });
});

describe('production Worker secret boundary', () => {
  test('pins both deployed and legacy Tinybird inventories for the cloud expand check', () => {
    const cloudCheck = ci.jobs['tinybird-schema-check'].steps.find(
      (step) => step.name === 'Tinybird deploy --check (trace_flow_prod)',
    );
    expect(cloudCheck.env.TINYBIRD_CURRENT_REF).toBe('HEAD^');
    expect(cloudCheck.env.TINYBIRD_LEGACY_REF).toBe('11613a4619444adb0e27abc3df958cebb43cc280');
  });

  test.each(['Deploy Raw API Worker', 'Deploy Pipes API Worker'])(
    '%s scopes secret uploads and deployment to production',
    (stepName) => {
      const step = deploy.jobs['deploy-api'].steps.find(({ name }) => name === stepName);

      expect(step.with.secrets).toBeTruthy();
      expect(step.with.environment).toBe('production');
      expect(step.with.command).toContain('deploy --env production');
    },
  );

  test('sets Node 24 before every production Wrangler invocation', () => {
    let checkedJobs = 0;
    for (const job of Object.values(deploy.jobs)) {
      const wranglerIndex = job.steps?.findIndex((step) =>
        /wrangler|assert-agent-prod-resources|migrate-agent-ingestion/.test(
          `${step.uses ?? ''} ${step.run ?? ''}`,
        ),
      );
      if (wranglerIndex === undefined || wranglerIndex < 0) continue;
      const setupIndex = job.steps.findIndex((step) =>
        step.uses?.startsWith('actions/setup-node@'),
      );
      expect(setupIndex).toBeGreaterThanOrEqual(0);
      expect(setupIndex).toBeLessThan(wranglerIndex);
      expect(job.steps[setupIndex].with['node-version']).toBe(24);
      checkedJobs++;
    }
    expect(checkedJobs).toBeGreaterThan(0);
  });

  test('keeps ingest in maintenance until the automatic migration and endpoint switch pass', () => {
    const currentRefJob = deploy.jobs['agent-delivery-current-ref'];
    const release = deploy.jobs['agent-delivery-current-ref'].steps.find(
      (step) => step.name === 'Resolve current deployed ref',
    );
    expect(currentRefJob.environment).toBe('Production');
    expect(currentRefJob.permissions).toEqual({ contents: 'read', deployments: 'read' });
    expect(release.env).not.toHaveProperty('BEFORE_SHA');
    expect(release.run).toContain('resolve-agent-tinybird-current-ref.mjs');
    expect(release.env.GITHUB_TOKEN).toBe('${{ github.token }}');
    expect(release.env.TB_TOKEN).toBe('${{ secrets.TINYBIRD_OPERATOR_TOKEN }}');
    expect(release.env.TB_TARGET_WORKSPACE).toBe('trace_flow_prod');
    const expand = deploy.jobs['deploy-tinybird-schema'].steps.find(
      (step) => step.name === 'Expand schema in trace_flow_prod',
    );
    expect(expand.env.TINYBIRD_DEPLOY_PHASE).toBe('expand');
    expect(expand.env.TINYBIRD_CURRENT_REF).toBe(
      '${{ needs.agent-delivery-current-ref.outputs.current_ref }}',
    );
    expect(expand.env.TINYBIRD_LEGACY_REF).toBe('11613a4619444adb0e27abc3df958cebb43cc280');
    expect(expand.env.TB_TOKEN).toBe('${{ secrets.TINYBIRD_DEPLOY_TOKEN }}');
    const pause = deploy.jobs['deploy-agent-ingest-maintenance'].steps.find(
      (step) => step.name === 'Deploy retryable maintenance response',
    );
    expect(pause.with.command).toContain('AGENT_INGEST_MAINTENANCE:true');
    const status = deploy.jobs['agent-delivery-migration-status'].steps.find(
      (step) => step.name === 'Read migration status',
    );
    for (const jobName of ['agent-delivery-migration-status', 'migrate-agent-ingestion']) {
      const setupNode = deploy.jobs[jobName].steps.find((step) =>
        step.uses?.startsWith('actions/setup-node@'),
      );
      expect(setupNode.with['node-version']).toBe(24);
    }
    expect(status.run).toContain('--status');
    expect(status.run).toContain('migration_required');
    expect(status.env.TB_TOKEN).toBe('${{ secrets.TINYBIRD_OPERATOR_TOKEN }}');
    expect(deploy.jobs['deploy-agent-ingest-maintenance'].if).toContain(
      "migration_required == 'true'",
    );
    const migrate = deploy.jobs['migrate-agent-ingestion'].steps.find(
      (step) => step.name === 'Drain, build revision-1 baseline, index, and initial snapshots',
    );
    expect(migrate.run).toContain('migrate-agent-ingestion.ts');
    expect(migrate.run).toContain('--apply');
    expect(deploy.jobs['migrate-agent-ingestion'].if).toContain("migration_required == 'true'");
    expect(migrate.env.TB_TOKEN).toBe('${{ secrets.TINYBIRD_OPERATOR_TOKEN }}');
    const switchJob = deploy.jobs['switch-agent-tinybird'];
    expect(switchJob.needs).toContain('migrate-agent-ingestion');
    expect(switchJob.permissions.deployments).toBe('write');
    const marker = switchJob.steps.find(
      (step) => step.name === 'Record deployed Agent Tinybird ref',
    );
    const switchProof = switchJob.steps.find(
      (step) => step.name === 'Verify switched endpoint definitions',
    );
    const switchDeploy = switchJob.steps.find(
      (step) => step.name === 'Switch endpoints after verified migration',
    );
    expect(switchDeploy.env.TB_TOKEN).toBe('${{ secrets.TINYBIRD_DEPLOY_TOKEN }}');
    expect(switchProof.env.REQUESTED_CURRENT_REF).toBe('${{ github.sha }}');
    expect(switchProof.env.TB_TOKEN).toBe('${{ secrets.TINYBIRD_OPERATOR_TOKEN }}');
    expect(switchProof.env.TB_TARGET_WORKSPACE).toBe('trace_flow_prod');
    expect(switchProof.run).toContain('resolve-agent-tinybird-current-ref.mjs');
    expect(marker.with.script).toContain("task: 'deploy-agent-tinybird'");
    expect(marker.with.script).toContain("state: 'success'");
    expect(deploy.jobs['deploy-agent-ingest'].needs).toContain('switch-agent-tinybird');
    const resume = deploy.jobs['deploy-agent-ingest'].steps.find(
      (step) => step.name === 'Deploy Agent Ingest Worker',
    );
    expect(deploy.on.workflow_dispatch.inputs.agent_ingest_maintenance).toMatchObject({
      type: 'boolean',
      required: false,
      default: false,
    });
    expect(resume.with.command).toContain(
      "AGENT_INGEST_MAINTENANCE:${{ github.event_name == 'workflow_dispatch' && inputs.agent_ingest_maintenance && 'true' || 'false' }}",
    );
  });

  test('maps the dedicated delivery key to both Workers and scoped tokens to the consumer', () => {
    const configure = deploy.jobs['prepare-agent-delivery'].steps.find(
      (step) => step.name === 'Configure scoped Tinybird and delivery encryption secrets',
    );
    expect(configure.env.BODY_ENCRYPTION_ROOT_KEY).toBe(
      '${{ secrets.AGENT_DELIVERY_ENCRYPTION_ROOT_KEY }}',
    );
    expect(configure.run).toContain('apps/agent-consumer');
    expect(configure.run).toContain('apps/agent-ingest');
    expect(configure.env.TB_TOKEN).toBe('${{ secrets.TINYBIRD_OPERATOR_TOKEN }}');
    const tokenScript = readFileSync(
      new URL('./configure-agent-tinybird-tokens.mjs', import.meta.url),
      'utf8',
    );
    expect(tokenScript).toContain('TINYBIRD_AGENT_DELIVERY_READ_TOKEN');
    expect(tokenScript).toContain('TINYBIRD_AGENT_SNAPSHOT_TOKEN');
    expect(configure.run).not.toContain('TINYBIRD_ADMIN_TOKEN');
    expect(configure.run).not.toContain('TINYBIRD_AGENT_SNAPSHOT_CLEANUP_TOKEN');
  });
});

function matchesFilter(filters, name, path) {
  return filters[name].some((pattern) => new Glob(pattern).match(path));
}

describe('MCP Worker change detection', () => {
  const filters = YAML.parse(
    ci.jobs.changes.steps.find((step) => step.id === 'filter').with.filters,
  );
  const mcpJob = ci.jobs.mcp;
  const stepCommands = mcpJob.steps.map((step) => step.run ?? '').join('\n');

  test('exposes an mcp change output and schedules the MCP Worker job from it', () => {
    expect(ci.jobs.changes.outputs.mcp).toBe('${{ steps.filter.outputs.mcp }}');
    expect(mcpJob.name).toBe('MCP Worker');
    expect(mcpJob.if).toBe(
      "needs.changes.outputs.mcp == 'true' || needs.changes.outputs.root == 'true'",
    );
    expect(ci.jobs.status.needs).toContain('mcp');
    expect(ci.jobs.status.steps[0].run).toContain("contains(needs.*.result, 'failure')");
    expect(ci.jobs.status.steps[0].run).toContain("contains(needs.*.result, 'cancelled')");
  });

  test('app-only MCP changes select the MCP Worker without the Analyst Sandbox', () => {
    expect(matchesFilter(filters, 'mcp', 'apps/mcp/src/index.ts')).toBe(true);
    expect(matchesFilter(filters, 'mcp', 'apps/mcp/src/__tests__/index.test.ts')).toBe(true);
    expect(matchesFilter(filters, 'analyst-sandbox', 'apps/mcp/src/index.ts')).toBe(false);
    expect(matchesFilter(filters, 'mcp', 'apps/web/src/app/page.tsx')).toBe(false);
  });

  test('MCP runtime dependency changes select the MCP Worker and remaining package checks', () => {
    expect(matchesFilter(filters, 'mcp', 'packages/mcp-core/src/index.ts')).toBe(true);
    expect(matchesFilter(filters, 'analyst-sandbox', 'packages/mcp-core/src/index.ts')).toBe(true);
    expect(matchesFilter(filters, 'mcp', 'packages/logging/src/index.ts')).toBe(true);
    expect(matchesFilter(filters, 'mcp', 'packages/utils/src/index.ts')).toBe(true);
    expect(matchesFilter(filters, 'utils', 'packages/utils/src/index.ts')).toBe(true);
  });

  test('MCP Worker check runs format, lint, type-check, tests, and local Wrangler validation', () => {
    expect(stepCommands).toContain('bun prettier --check "apps/mcp/**/*.{ts,tsx,js,jsx,json}"');
    expect(stepCommands).toContain('bun --cwd apps/mcp lint');
    expect(stepCommands).toContain('bun --cwd apps/mcp type-check');
    expect(stepCommands).toContain('bun --cwd apps/mcp test');
    const wranglerCommands = stepCommands
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.includes('wrangler deploy'));
    expect(wranglerCommands).toEqual([
      'bunx wrangler deploy --env="" --dry-run',
      'bunx wrangler deploy --env preview --dry-run',
      'bunx wrangler deploy --env production --dry-run',
    ]);
  });

  test('dependency-only MCP changes cannot reuse a stale Turbo type-check or test cache', () => {
    const result = Bun.spawnSync({
      cmd: [
        'bunx',
        'turbo',
        'run',
        'type-check',
        'test',
        '--filter=@trace-flow/mcp',
        '--dry-run=json',
      ],
      cwd: new URL('../..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode).toBe(0);

    const stdout = result.stdout.toString();
    const dryRun = JSON.parse(stdout.slice(stdout.indexOf('{')));
    expect(dryRun.tasks.map((task) => task.taskId).sort()).toEqual([
      '@trace-flow/mcp#test',
      '@trace-flow/mcp#type-check',
    ]);

    for (const task of dryRun.tasks) {
      expect(task.dependencies).toEqual([]);
      expect(task.resolvedTaskDefinition.dependsOn).toEqual([]);
      expect(task.resolvedTaskDefinition.cache).toBe(true);
      const hashedPaths = Object.keys(task.inputs);
      expect(hashedPaths.length).toBeGreaterThan(0);
      expect(hashedPaths.every((path) => !path.includes('packages/'))).toBe(true);
      expect(hashedPaths.some((path) => path.startsWith('src/'))).toBe(true);
    }

    expect(mcpJob.steps.some((step) => step.name === 'Cache Turbo')).toBe(false);
    expect(stepCommands).not.toContain('turbo run');
    expect(stepCommands).toContain('bun --cwd apps/mcp type-check');
    expect(stepCommands).toContain('bun --cwd apps/mcp test');
  });
});
