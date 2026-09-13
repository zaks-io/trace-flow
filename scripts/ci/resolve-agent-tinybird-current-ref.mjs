import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';

export const INITIAL_AGENT_TINYBIRD_REF = '844d8f0313af18ac73ad60bdbe7f81dc3d8f019d';
export const AGENT_TINYBIRD_DEPLOYMENT_ENVIRONMENT = 'Production';
export const AGENT_TINYBIRD_DEPLOYMENT_TASK = 'deploy-agent-tinybird';

const COMMIT_SHA = /^[0-9a-f]{40}$/;
const MAX_DEPLOYMENTS = 30;
const MAX_LIVE_PIPES = 1_000;

function required(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function defaultGit(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

async function jsonRequest(fetchImpl, url, token, provider) {
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      ...(provider === 'GitHub' ? { 'X-GitHub-Api-Version': '2022-11-28' } : {}),
    },
  });
  if (!response.ok) throw new Error(`${provider} request failed: HTTP ${response.status}`);
  return response.json();
}

async function latestSuccessfulDeploymentRef(options) {
  const repository = required(options.repository, 'GITHUB_REPOSITORY');
  const [owner, repo, extra] = repository.split('/');
  if (!owner || !repo || extra) throw new Error('GITHUB_REPOSITORY must be owner/repository');
  const token = required(options.githubToken, 'GITHUB_TOKEN');
  const url = new URL(`https://api.github.com/repos/${owner}/${repo}/deployments`);
  url.searchParams.set('environment', AGENT_TINYBIRD_DEPLOYMENT_ENVIRONMENT);
  url.searchParams.set('task', AGENT_TINYBIRD_DEPLOYMENT_TASK);
  url.searchParams.set('per_page', String(MAX_DEPLOYMENTS));
  const deployments = await jsonRequest(options.fetchImpl, url, token, 'GitHub');
  if (!Array.isArray(deployments)) throw new Error('GitHub returned no deployment list');
  if (deployments.length > MAX_DEPLOYMENTS)
    throw new Error('GitHub returned an oversized deployment list');

  for (const deployment of deployments) {
    if (deployment?.task !== AGENT_TINYBIRD_DEPLOYMENT_TASK) continue;
    if (!Number.isSafeInteger(deployment.id) || deployment.id <= 0)
      throw new Error('GitHub returned an invalid Agent Tinybird deployment');
    const statusesUrl = new URL(
      `https://api.github.com/repos/${owner}/${repo}/deployments/${deployment.id}/statuses`,
    );
    statusesUrl.searchParams.set('per_page', '1');
    const statuses = await jsonRequest(options.fetchImpl, statusesUrl, token, 'GitHub');
    if (!Array.isArray(statuses)) throw new Error('GitHub returned no deployment status list');
    if (statuses[0]?.state !== 'success') continue;
    if (typeof deployment.sha !== 'string' || !COMMIT_SHA.test(deployment.sha))
      throw new Error('Successful Agent Tinybird deployment has no exact commit SHA');
    return deployment.sha;
  }
  return undefined;
}

function expectedEndpointPipes(ref, options) {
  const git = options.git ?? defaultGit;
  const files = git(['ls-tree', '-r', '--name-only', ref, '--', 'pipes'], options.cwd)
    .trim()
    .split('\n')
    .filter((path) => path.endsWith('.pipe'));
  if (files.length === 0) throw new Error(`Candidate ${ref} contains no endpoint pipes`);

  const definitions = new Map();
  for (const path of files) {
    if (basename(path).endsWith('_copy.pipe')) continue;
    const content = git(['show', `${ref}:${path}`], options.cwd);
    if (/^TYPE[\t ]+COPY(?:[\t ]|$)/m.test(content)) continue;
    const name = basename(path, '.pipe');
    if (definitions.has(name)) throw new Error(`Candidate has duplicate pipe ${name}`);
    definitions.set(name, content.trim());
  }
  if (definitions.size === 0) throw new Error(`Candidate ${ref} contains no restorable endpoints`);
  return definitions;
}

async function liveEndpointPipes(options) {
  const host = required(options.tinybirdHost, 'TB_HOST').replace(/\/$/, '');
  const token = required(options.tinybirdToken, 'TB_TOKEN');
  const url = new URL('/v0/pipes', host);
  url.searchParams.set('attrs', 'name,content');
  const result = await jsonRequest(options.fetchImpl, url, token, 'Tinybird');
  if (!Array.isArray(result.pipes)) throw new Error('Tinybird returned no pipe list');
  if (result.pipes.length > MAX_LIVE_PIPES)
    throw new Error('Tinybird returned an oversized pipe list');

  const definitions = new Map();
  for (const pipe of result.pipes) {
    if (typeof pipe?.name !== 'string' || typeof pipe.content !== 'string')
      throw new Error('Tinybird returned an incomplete pipe definition');
    if (definitions.has(pipe.name))
      throw new Error(`Tinybird returned duplicate pipe ${pipe.name}`);
    definitions.set(pipe.name, pipe.content.trim());
  }
  return definitions;
}

async function verifyWorkspaceOperator(options) {
  const host = required(options.tinybirdHost, 'TB_HOST').replace(/\/$/, '');
  const token = required(options.tinybirdToken, 'TB_TOKEN');
  const expectedWorkspace = required(options.tinybirdWorkspace, 'TB_TARGET_WORKSPACE');
  const [workspace, result] = await Promise.all([
    jsonRequest(options.fetchImpl, new URL('/v1/workspace', host), token, 'Tinybird'),
    jsonRequest(options.fetchImpl, new URL('/v0/tokens', host), token, 'Tinybird'),
  ]);
  if (workspace.name !== expectedWorkspace)
    throw new Error('Tinybird operator credential resolved to the wrong workspace');
  if (!Array.isArray(result.tokens)) throw new Error('Tinybird returned no token list');
  const matches = result.tokens.filter((entry) => entry?.token === token);
  if (
    matches.length !== 1 ||
    !Array.isArray(matches[0].scopes) ||
    matches[0].scopes.length !== 1 ||
    matches[0].scopes[0]?.type !== 'ADMIN'
  ) {
    throw new Error('Tinybird operator credential must be an ADMIN token');
  }
}

function verifiedCommit(ref, options) {
  if (!COMMIT_SHA.test(ref) || /^0+$/.test(ref))
    throw new Error('Current Agent Tinybird ref must be an exact nonzero commit SHA');
  const git = options.git ?? defaultGit;
  const resolved = git(['rev-parse', '--verify', `${ref}^{commit}`], options.cwd).trim();
  if (resolved !== ref)
    throw new Error(`Current Agent Tinybird ref ${ref} is not available locally`);
}

export async function resolveAgentTinybirdCurrentRef(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const requestedRef = options.requestedRef?.trim();
  let source = 'manual input';
  let ref = requestedRef;
  if (!ref) {
    ref = await latestSuccessfulDeploymentRef({
      ...options,
      fetchImpl,
      repository: options.repository ?? process.env.GITHUB_REPOSITORY,
      githubToken: options.githubToken ?? process.env.GITHUB_TOKEN,
    });
    source = ref ? 'successful GitHub deployment' : 'initial migration pin';
    ref ??= options.initialRef ?? INITIAL_AGENT_TINYBIRD_REF;
  }

  verifiedCommit(ref, options);
  const tinybird = {
    ...options,
    fetchImpl,
    tinybirdHost: options.tinybirdHost ?? process.env.TB_HOST,
    tinybirdToken: options.tinybirdToken ?? process.env.TB_TOKEN,
    tinybirdWorkspace: options.tinybirdWorkspace ?? process.env.TB_TARGET_WORKSPACE,
  };
  await verifyWorkspaceOperator(tinybird);
  const [expected, live] = await Promise.all([
    Promise.resolve(expectedEndpointPipes(ref, options)),
    liveEndpointPipes(tinybird),
  ]);
  for (const [name, content] of expected) {
    if (!live.has(name))
      throw new Error(`Live Tinybird endpoint is missing candidate pipe ${name}`);
    if (live.get(name) !== content)
      throw new Error(`Live Tinybird endpoint differs from candidate pipe ${name}`);
  }
  const digest = createHash('sha256')
    .update(
      [...expected]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, content]) => `${name}\0${content}\0`)
        .join(''),
    )
    .digest('hex');
  return { ref, source, pipeCount: expected.size, digest };
}

if (import.meta.main) {
  const result = await resolveAgentTinybirdCurrentRef({
    requestedRef: process.env.REQUESTED_CURRENT_REF,
    cwd: process.cwd(),
  });
  console.error(
    `Verified ${result.pipeCount} live Agent Tinybird endpoints against ${result.source} ${result.ref} (${result.digest}).`,
  );
  console.log(result.ref);
}
