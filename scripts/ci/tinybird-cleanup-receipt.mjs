import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const TASK = 'tinybird-cleanup-tra-405';
export async function cleanupReceipt(options = {}) {
  const repository = options.repository ?? process.env.GITHUB_REPOSITORY;
  const token = options.token ?? process.env.GITHUB_TOKEN;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !token)
    throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required for the cleanup receipt');
  const fetchImpl = options.fetchImpl ?? fetch;
  const request = async (path, init = {}) => {
    const response = await fetchImpl(
      new URL(`/repos/${repository}/${path}`, 'https://api.github.com'),
      {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
      },
    );
    if (!response.ok) throw new Error(`Cleanup receipt request failed: HTTP ${response.status}`);
    return response.json();
  };
  const deployments = await request(`deployments?task=${TASK}&environment=Production&per_page=100`);
  if (!Array.isArray(deployments) || deployments.length >= 100)
    throw new Error('Cleanup receipt inventory is missing or exceeds its bound');
  for (const deployment of deployments) {
    if (deployment.task !== TASK || !Number.isSafeInteger(deployment.id))
      throw new Error('Invalid cleanup receipt identity');
    // Creation consumes approval even if apply or the later success status fails.
    return { consumed: true, request };
  }
  return { consumed: false, request };
}

export async function consumeCleanupApproval(options = {}) {
  const receipt = await cleanupReceipt(options);
  if (receipt.consumed) throw new Error('Initial cleanup approval is already consumed');
  const sha = options.sha ?? process.env.GITHUB_SHA;
  if (!/^[0-9a-f]{40}$/.test(sha ?? ''))
    throw new Error('GITHUB_SHA is required for the cleanup receipt');
  const deployment = await receipt.request('deployments', {
    method: 'POST',
    body: JSON.stringify({
      ref: sha,
      task: TASK,
      environment: 'Production',
      auto_merge: false,
      required_contexts: [],
      production_environment: true,
      description: 'TRA-405 cleanup approval consumed',
    }),
  });
  if (!Number.isSafeInteger(deployment.id))
    throw new Error('GitHub returned no cleanup deployment receipt');
  return deployment.id;
}

export async function recordCleanupSuccess(id, options = {}) {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Valid cleanup receipt ID required');
  const receipt = await cleanupReceipt(options);
  await receipt.request(`deployments/${id}/statuses`, {
    method: 'POST',
    body: JSON.stringify({
      state: 'success',
      environment: 'Production',
      description: 'TRA-405 cleanup applied; original approval cannot be reused',
    }),
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'check')
    console.log((await cleanupReceipt()).consumed ? 'true' : 'false');
  else if (process.argv[2] === 'consume') console.log(await consumeCleanupApproval());
  else if (process.argv[2] === 'success') await recordCleanupSuccess(Number(process.argv[3]));
  else throw new Error('Use check, consume or success');
}
