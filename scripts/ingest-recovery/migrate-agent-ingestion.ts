import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentRecoveryClient } from './agent-transport';
import { runBaselineCopy } from './agent-baseline-copy';
import { verifyMigrationTarget } from './agent-migration-target';
import { verifyAgentSnapshotParity } from './agent-snapshot-parity';
import {
  inspectBaseline,
  intersectMigrationWindows,
  migrationOrganizations,
  MIGRATION_ID,
  retainedMigrationWindow,
  verifyBaseline,
} from './agent-migration-proof';
import {
  controlPlaneMigrationLock,
  controlPlaneMigrationOrganizations,
  requireAgentProducerMaintenance,
  requireDrainedAgentQueues,
  startMigrationRuntime,
} from './agent-migration-runtime';

const { values } = parseArgs({
  options: {
    status: { type: 'boolean' },
    apply: { type: 'boolean' },
    'previous-ref': { type: 'string' },
  },
});
if (
  Boolean(values.status) === Boolean(values.apply) ||
  !/^[0-9a-f]{40}$/.test(values['previous-ref'] ?? '')
) {
  throw new Error('Use exactly one of --status or --apply, and --previous-ref <40-character SHA>');
}

const runtime = await startMigrationRuntime();
try {
  const global = new AgentRecoveryClient('__migration__', runtime.url);
  const globalState = await global.call('inspectGlobalIngestionMigration', {});
  if (values.status) {
    console.log(JSON.stringify({ migration_required: globalState?.complete !== true }));
  } else {
    await requireAgentProducerMaintenance();
    await requireDrainedAgentQueues();
    const copyWindow = await global.call('beginBaselineMigrationWindow', retainedMigrationWindow());
    let retainedWindow = intersectMigrationWindows(copyWindow, retainedMigrationWindow());
    const organizations = await controlPlaneMigrationOrganizations();
    const sourceOrganizations = await migrationOrganizations(runtime.tb, retainedWindow);
    const activeOrganizations = new Set(organizations);
    const excludedOrganizations = sourceOrganizations.filter(
      (orgId) => !activeOrganizations.has(orgId),
    );
    if (excludedOrganizations.length > 0) {
      console.error(
        JSON.stringify({
          event: 'agent_ingestion_inactive_organizations_excluded',
          count: excludedOrganizations.length,
        }),
      );
    }
    const pending: string[] = [];
    for (const orgId of organizations) {
      const recovery = new AgentRecoveryClient(orgId, runtime.url);
      const state = await recovery.call('inspectIngestionMigration', {});
      await verifyMigrationTarget(runtime.tb, state.migrationTarget);
      if (state.migration?.complete !== true) pending.push(orgId);
      else await controlPlaneMigrationLock(orgId, MIGRATION_ID, 'complete');
    }
    const proof: Record<string, unknown>[] = [];
    for (const orgId of pending) {
      if (!(await controlPlaneMigrationLock(orgId, MIGRATION_ID, 'begin'))) continue;
      const recovery = new AgentRecoveryClient(orgId, runtime.url);
      const drainDeadline = Date.now() + 5 * 60_000;
      while (true) {
        const status = await recovery.call('inspectIngestionMigration', {});
        if (status.legacy.queuedRows === 0 && status.legacy.flushing === false) break;
        if (Date.now() >= drainDeadline)
          throw new Error('Legacy organization ingestion did not drain');
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
      await recovery.call('freezeIngestionMigration', { migrationId: MIGRATION_ID });
      let categories = await inspectBaseline(runtime.tb, orgId, retainedWindow);
      const before = await recovery.call('inspectIngestionMigration', {});
      const jobs: string[] = [];
      if (!before.migration) {
        for (const category of categories) {
          if (category.rows === 0) continue;
          jobs.push(await runBaselineCopy(runtime.tb, recovery, category.category, copyWindow));
        }
      }
      retainedWindow = intersectMigrationWindows(copyWindow, retainedMigrationWindow());
      categories = await inspectBaseline(runtime.tb, orgId, retainedWindow);
      for (const category of categories)
        await verifyBaseline(runtime.tb, orgId, retainedWindow, category);
      const dirtyDays = [...new Set(categories.flatMap((category) => category.days))].sort();
      const baselineProof = {
        migration: MIGRATION_ID,
        orgId,
        window: retainedWindow,
        copyWindow,
        categories,
        previousRef: values['previous-ref'],
      };
      const proofSha256: string =
        before.migration?.proofSha256 ??
        createHash('sha256').update(JSON.stringify(baselineProof)).digest('hex');
      await recovery.call('seedIngestionMigration', { proofSha256, dirtyDays });
      const snapshotDeadline = Date.now() + 60 * 60_000;
      let snapshotGeneration = 0;
      while (true) {
        const state = await recovery.call('inspectIngestionMigration', {});
        if (state.coordinator.incompleteDays !== 0)
          throw new Error('Migration has incomplete snapshot days');
        if (state.coordinator.dirtyDays === 0 && state.coordinator.gatePhase === 'open') {
          snapshotGeneration = state.coordinator.lastSnapshotGeneration;
          break;
        }
        if (Date.now() >= snapshotDeadline)
          throw new Error('Initial snapshots did not finish before the migration deadline');
        await new Promise((resolve) => setTimeout(resolve, 10_000));
      }
      await verifyAgentSnapshotParity(runtime.tb, orgId, retainedWindow);
      const result = await recovery.call('completeIngestionMigration', { proofSha256 });
      if (result.complete !== true || result.proofSha256 !== proofSha256)
        throw new Error('Migration completion was not durably acknowledged');
      await controlPlaneMigrationLock(orgId, MIGRATION_ID, 'complete');
      proof.push({
        ...baselineProof,
        proofSha256,
        jobs,
        snapshotGeneration,
        preservedLegacyRecoveryRows: before.legacy.blockedRecoveryRows,
        preservedLegacyRecoveryRecords: before.legacy.blockedRecoveryRecords,
      });
      console.error(
        JSON.stringify({
          event: 'agent_ingestion_org_migrated',
          categories: categories.map((category) => ({
            category: category.category,
            rows: category.rows,
          })),
          snapshotGeneration,
        }),
      );
    }
    const globalProofSha256 = createHash('sha256')
      .update(JSON.stringify({ migration: MIGRATION_ID, organizations: organizations.sort() }))
      .digest('hex');
    const completed = await global.call('completeGlobalIngestionMigration', {
      proofSha256: globalProofSha256,
    });
    if (completed.complete !== true || completed.proofSha256 !== globalProofSha256)
      throw new Error('Global migration completion was not acknowledged');
    const directory = join(process.cwd(), 'artifacts');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `agent-ingestion-migration-${Date.now()}.json`);
    writeFileSync(
      path,
      JSON.stringify(
        {
          migration: MIGRATION_ID,
          previousRef: values['previous-ref'],
          completedAt: new Date().toISOString(),
          proof,
        },
        null,
        2,
      ),
      { flag: 'wx', mode: 0o600 },
    );
    console.log(JSON.stringify({ migrated: pending.length, proofArtifact: path }));
  }
} finally {
  runtime.close();
}
