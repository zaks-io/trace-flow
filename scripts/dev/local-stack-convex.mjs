import { execFileSync } from 'node:child_process';

export function localStackAccount(email) {
  const cliDir = process.env.STACK_CONVEX_CLI_DIR;
  if (!cliDir) throw new Error('STACK_CONVEX_CLI_DIR is required');
  const env = { ...process.env };
  // The private CLI directory owns the local deployment configuration.
  for (const name of [
    'CONVEX_DEPLOYMENT',
    'CONVEX_DEPLOY_KEY',
    'CONVEX_SELF_HOSTED_URL',
    'CONVEX_SELF_HOSTED_ADMIN_KEY',
  ])
    delete env[name];

  function convex(args) {
    try {
      return execFileSync('bunx', ['convex', ...args], {
        cwd: cliDir,
        env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      // CLI errors can include the returned credentials or deployment configuration.
      throw new Error('local Convex command failed; check the local backend and private CLI setup');
    }
  }

  let users;
  try {
    users = convex(['data', 'users', '--format', 'jsonl', '--limit', '10000'])
      .split('\n')
      .filter((line) => line.trim().startsWith('{'))
      .map((line) => JSON.parse(line));
  } catch {
    throw new Error('local Convex command failed while reading users');
  }
  const user = users.find((row) => row.email === email.toLowerCase());
  if (!user?.orgId) {
    throw new Error(
      'no local user with an org; sign in first with scripts/dev/local-stack.sh login-url',
    );
  }

  let apiKeys;
  try {
    apiKeys = JSON.parse(
      convex(['run', 'apiKeys:listByOrgId', JSON.stringify({ orgId: user.orgId })]),
    );
  } catch {
    throw new Error('local Convex command failed while reading API keys');
  }
  if (!Array.isArray(apiKeys)) throw new Error('local Convex returned invalid API key records');
  if (apiKeys.length === 0)
    throw new Error('org has no API keys; finish onboarding in the web app first');
  return { user, apiKeys };
}
