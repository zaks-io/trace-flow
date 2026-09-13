import type { AgentTinybirdClient } from './agent-transport';

export async function verifyMigrationTarget(
  tb: AgentTinybirdClient,
  target: unknown,
): Promise<void> {
  if (
    !target ||
    typeof target !== 'object' ||
    !('tinybirdHost' in target) ||
    !('appendTokenSha256' in target) ||
    target.tinybirdHost !== tb.host ||
    typeof target.appendTokenSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(target.appendTokenSha256)
  ) {
    throw new Error('Migration consumer Tinybird target is missing or mismatched');
  }
  const fingerprints = await tb.tokenFingerprints();
  if (!fingerprints.includes(target.appendTokenSha256)) {
    throw new Error(
      'Migration Tinybird credentials do not belong to the deployed consumer workspace',
    );
  }
}
