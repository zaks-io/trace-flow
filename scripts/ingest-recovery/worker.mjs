import { isArchiveCanonicalIdentifier } from '../../packages/types/src/archive.ts';

const AGENT_METHODS = new Set([
  'beginFactRebuild',
  'listRebuildFacts',
  'completeFactRebuild',
  'inspectFactRepairCapacity',
  'compactFactRepairDuplicates',
]);
const ARCHIVE_METHODS = new Set([
  'getStorageBudget',
  'inspectArchivePart',
  'applyArchiveRepairChunk',
  'verifyArchiveRepairPage',
  'finalizeArchiveRepair',
]);
const READ_METHODS = new Set([
  'listRecovery',
  'listRebuildFacts',
  'inspectArchivePart',
  'getStorageBudget',
  'inspectFactRepairCapacity',
]);
const METHODS = new Set([
  'listRecovery',
  'reconcileRecovery',
  'replayDlq',
  ...AGENT_METHODS,
  ...ARCHIVE_METHODS,
]);
const SAFE_ARCHIVE_REASONS = new Set([
  'archive_repair_in_progress',
  'archive_repair_precondition_failed',
  'archive_repair_plan_mismatch',
  'archive_repair_chunk_mismatch',
  'archive_repair_invalid',
  'archive_verification_required',
  'archive_verification_snapshot_mismatch',
  'archive_verification_invalid',
  'archive_verification_cap_exceeded',
  'archive_verification_corrupt',
  'archive_verification_object_invalid',
  'archive_verification_ledger_invalid',
  'archive_verification_manifest_invalid',
  'archive_verification_payload_invalid',
  'archive_key_version_mismatch',
  'ledger_scope_mismatch',
  'ledger_state_corrupt',
  'payload_hash_mismatch',
  'pending_commit_exists',
  'pending_intent_corrupt',
  'pending_intent_head_mismatch',
  'pending_intent_mismatch',
  'storage_cap_exceeded',
  'storage_budget_identity_mismatch',
  'storage_budget_uninitialized',
  'upload_too_large',
]);

const BAD_REQUEST_ARCHIVE_REASONS = new Set([
  'archive_repair_invalid',
  'archive_verification_invalid',
]);

function safeArchiveReason(error) {
  if (!error || typeof error.message !== 'string') return null;
  const reason = error.message.replace(/^ArchiveContractError:\s*/u, '');
  return SAFE_ARCHIVE_REASONS.has(reason) ? reason : null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      return new Response('Recovery is available through the local operator tool', { status: 403 });
    }
    if (request.headers.has('Origin'))
      return new Response('Browser requests are forbidden', { status: 403 });
    if (request.method !== 'POST' || request.headers.get('Content-Type') !== 'application/json') {
      return new Response('Send a JSON POST', { status: 400 });
    }
    const method = url.pathname.slice(1);
    if (!METHODS.has(method)) return new Response('Unknown recovery method', { status: 404 });
    let input;
    try {
      input = await request.json();
    } catch {
      return new Response('Invalid JSON', { status: 400 });
    }
    if (
      !input ||
      !['proxy', 'agent', 'archive'].includes(input.pipeline) ||
      typeof input.shardId !== 'string'
    ) {
      return new Response('pipeline and shardId are required', { status: 400 });
    }
    if (AGENT_METHODS.has(method) && input.pipeline !== 'agent') {
      return new Response('Fact rebuild requires the agent pipeline', { status: 400 });
    }
    if (ARCHIVE_METHODS.has(method) !== (input.pipeline === 'archive')) {
      return new Response('Archive recovery methods require the archive pipeline', { status: 400 });
    }
    if (
      method === 'getStorageBudget' &&
      (!isArchiveCanonicalIdentifier(input.shardId) || input.options?.orgId !== input.shardId)
    ) {
      return new Response('Storage budget requires a confirmed organization', { status: 400 });
    }
    if (!READ_METHODS.has(method) && input.confirm !== 'apply-recovery') {
      return new Response('Explicit apply-recovery confirmation is required', { status: 400 });
    }
    const service =
      input.pipeline === 'proxy'
        ? env.PROXY_RECOVERY
        : input.pipeline === 'agent'
          ? env.AGENT_RECOVERY
          : env.ARCHIVE_RECOVERY;
    try {
      const result = await service[method](input.shardId, input.options);
      return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
      const reason = input.pipeline === 'archive' ? safeArchiveReason(error) : null;
      if (reason) {
        const status =
          reason === 'storage_cap_exceeded'
            ? 507
            : reason === 'upload_too_large'
              ? 413
              : BAD_REQUEST_ARCHIVE_REASONS.has(reason)
                ? 400
                : 409;
        return Response.json({ error: 'archive_recovery_rejected', reason }, { status });
      }
      const diagnostic =
        error instanceof Error ? error : new Error('Recovery RPC threw a non-Error value');
      console.error('recovery_bridge_rpc_failed', { pipeline: input.pipeline, method }, diagnostic);
      return new Response('Recovery failed; inspect the consumer logs', { status: 502 });
    }
  },
};
