#!/usr/bin/env bun
import { acquireExecutor, executorIdentity, syncDirectory } from './agent-executor';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import { AgentSnapshot, DATASOURCES, LEGACY_DATASOURCES, quote } from './agent-data';
import { AgentRecoveryClient, AgentTinybirdClient } from './agent-transport';
import { captureSnapshot, graphFingerprint } from './agent-snapshot';
import { rebuild, RebuildJournal, validateSnapshot, reconcileDeleteJob } from './agent-rebuild';

const { values } = parseArgs({
  options: {
    org: { type: 'string' },
    'tinybird-config': { type: 'string' },
    recovery: { type: 'string', default: 'http://127.0.0.1:8799' },
    backup: { type: 'string' },
    operation: { type: 'string' },
    reason: { type: 'string' },
    apply: { type: 'boolean', default: false },
    'confirm-org': { type: 'string' },
    'delete-job': { type: 'string', multiple: true },
  },
});

let executor: Awaited<ReturnType<typeof acquireExecutor>> | undefined;
try {
  if (!values.org || !/^[A-Za-z0-9_-]{1,256}$/.test(values.org) || !values['tinybird-config']) {
    throw new Error(
      'Usage: bun scripts/ingest-recovery/rebuild-agent.ts --org ORG --tinybird-config PATH [--apply --confirm-org ORG --operation UUID --reason TEXT --backup NEW_DIRECTORY]',
    );
  }
  const tinybird = new AgentTinybirdClient(values['tinybird-config']);
  const recovery = new AgentRecoveryClient(values.org, values.recovery);
  const graph = await tinybird.graph(
    [...Object.values(DATASOURCES), ...Object.values(LEGACY_DATASOURCES)],
    resolve(import.meta.dir, '../..'),
  );
  if (!values.apply) {
    const counts = [];
    for (const table of [...graph.facts, ...graph.derived]) {
      const result = await tinybird.sql(
        `SELECT count() AS rows FROM ${table} WHERE OrgId=${quote(values.org)}`,
      );
      counts.push({ table, physicalRows: result.data[0]?.rows });
    }
    console.log(
      JSON.stringify(
        {
          mode: 'read-only',
          org: values.org,
          host: tinybird.host,
          graphFingerprint: graphFingerprint(graph),
          tables: counts,
          note: 'Application pauses this organization and creates a complete backup before deleting any rows. This live count is not a quiescent snapshot.',
        },
        null,
        2,
      ),
    );
  } else {
    if (
      values['confirm-org'] !== values.org ||
      !values.operation ||
      !values.backup ||
      !values.reason?.trim()
    ) {
      throw new Error(
        'Apply requires matching --confirm-org, a stable --operation, --backup directory and --reason',
      );
    }
    executor = await acquireExecutor(tinybird.host, values.org, resolve(values.backup));
    const executorId = executorIdentity(resolve(values.backup));
    recovery.bindExecutor(executorId, executor.assertHeld);
    recovery.bindWorkspace(
      tinybird.host,
      await tinybird.workspaceId(),
      await tinybird.tokenFingerprints(),
    );
    const paused = await recovery.call('beginFactRebuild', {
      operationId: values.operation,
      reason: values.reason,
    });
    if (paused.status === 'completed') {
      console.log('This operation is already complete.');
    } else {
      if (paused.status !== 'quiescent')
        throw new Error(
          'An insert is still in flight. The pause is durable; retry this same operation after it finishes.',
        );
      const pausedGraph = await tinybird.graph(
        [...Object.values(DATASOURCES), ...Object.values(LEGACY_DATASOURCES)],
        resolve(import.meta.dir, '../..'),
      );
      if (graphFingerprint(graph) !== graphFingerprint(pausedGraph))
        throw new Error('Materialization graph changed while pausing');
      mkdirSync(values.backup, { recursive: true, mode: 0o700 });
      const snapshotPath = resolve(values.backup, 'snapshot.sqlite');
      if (!existsSync(snapshotPath)) {
        const snapshot = new AgentSnapshot(snapshotPath, true);
        try {
          await captureSnapshot(snapshot, tinybird, recovery, values.operation, graph);
        } finally {
          snapshot.db.close();
        }
      }
      const snapshot = new AgentSnapshot(snapshotPath);
      try {
        if (
          snapshot.meta('complete') !== true ||
          snapshot.meta('org') !== values.org ||
          snapshot.meta('host') !== tinybird.host ||
          snapshot.meta('tinybirdWorkspaceId') !== recovery.matchedWorkspaceId ||
          snapshot.meta('operationId') !== values.operation ||
          graphFingerprint(snapshot.meta('graph')) !== graphFingerprint(graph)
        ) {
          throw new Error(
            'Snapshot is incomplete or does not match the operation and deployed graph; preserve it and inspect the recovery guide before resuming',
          );
        }
        if (snapshot.fingerprint() !== snapshot.meta('fingerprint'))
          throw new Error('Snapshot fingerprint mismatch');
        await validateSnapshot(snapshot, tinybird);
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(snapshotPath)) hash.update(chunk);
        const backupSha256 = hash.digest('hex');
        syncDirectory(resolve(values.backup));
        const finalGraph = await tinybird.graph(
          [...Object.values(DATASOURCES), ...Object.values(LEGACY_DATASOURCES)],
          resolve(import.meta.dir, '../..'),
        );
        if (graphFingerprint(finalGraph) !== graphFingerprint(graph))
          throw new Error('Materialization graph changed during snapshot capture');
        const journal = new RebuildJournal(
          resolve(values.backup, 'journal.json'),
          values.operation,
        );
        for (const receipt of values['delete-job'] ?? []) {
          const [table, jobId, extra] = receipt.split('=');
          if (!table || !jobId || extra || ![...graph.facts, ...graph.derived].includes(table))
            throw new Error('Delete receipt must be TABLE=JOB_ID from this rebuild graph');
          await reconcileDeleteJob(tinybird, journal, values.org, table, jobId);
        }
        await rebuild(snapshot, tinybird, recovery, journal, values.reason, backupSha256);
        console.log(
          JSON.stringify({
            status: 'verified',
            operationId: values.operation,
            backup: snapshotPath,
            backupSha256,
          }),
        );
      } finally {
        snapshot.db.close();
      }
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Rebuild failed');
  if (values.apply)
    console.error(
      'If maintenance began, ingestion remains paused. Preserve the backup and journal; do not start another operation or repeat an uncertain write.',
    );
  process.exitCode = 1;
} finally {
  await executor?.release();
}
