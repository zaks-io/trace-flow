import { syncDirectory } from './agent-executor';
import { dirname, resolve } from 'node:path';
import { verifyRollups } from './agent-rollup-proof';
import { confirmExistingInsert } from './agent-insert-proof';
import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import {
  AgentSnapshot,
  CATEGORIES,
  DATASOURCES,
  LEGACY_DATASOURCES,
  ROW_IDENTITY_FIELDS,
  batches,
  quote,
  type Row,
} from './agent-data';
import { AgentRecoveryClient, AgentTinybirdClient, normalized } from './agent-transport';
import { confirmations, recoveryConfirmations, graphFingerprint } from './agent-snapshot';

type Journal = {
  operationId: string;
  steps: Record<string, { status: 'started' | 'done'; jobId?: string; startedAtMs?: number }>;
};

export class RebuildJournal {
  private state: Journal;
  constructor(
    private path: string,
    operationId: string,
  ) {
    try {
      this.state = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
      this.state = { operationId, steps: {} };
      writeFileSync(path, JSON.stringify(this.state), { flag: 'wx', mode: 0o600 });
      const fd = openSync(path, 'r');
      fsyncSync(fd);
      closeSync(fd);
      syncDirectory(dirname(path));
    }
    if (this.state.operationId !== operationId)
      throw new Error('Journal belongs to another operation');
  }
  get(key: string) {
    return this.state.steps[key];
  }
  set(key: string, value: Journal['steps'][string]) {
    this.state.steps[key] = value;
    const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.state), { flag: 'wx', mode: 0o600 });
    const fd = openSync(temporary, 'r');
    fsyncSync(fd);
    closeSync(fd);
    renameSync(temporary, this.path);
    syncDirectory(dirname(this.path));
  }
}

export async function reconcileDeleteJob(
  tinybird: AgentTinybirdClient,
  journal: RebuildJournal,
  org: string,
  table: string,
  jobId: string,
): Promise<void> {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(org)) throw new Error('Invalid organization identity');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error('Invalid datasource name');
  if (!jobId.trim()) throw new Error('Delete job ID is required');
  const key = `delete:${table}`;
  const prior = journal.get(key);
  if (prior?.status !== 'started' || prior.jobId || !Number.isSafeInteger(prior.startedAtMs)) {
    throw new Error(`Delete ${table} is not awaiting a job receipt`);
  }

  const result = await tinybird.request(`/v0/jobs/${encodeURIComponent(jobId)}`);
  const returnedId = [result.id, result.job_id].some(
    (value) => (typeof value === 'string' || typeof value === 'number') && String(value) === jobId,
  );
  const createdAtMs = parseTinybirdTimestamp(result.created_at);
  const condition = normalizeDeleteCondition(result.delete_condition);
  if (
    result.kind !== 'delete_data' ||
    !returnedId ||
    result.datasource?.name !== table ||
    condition !== `OrgId='${org}'` ||
    !Number.isFinite(createdAtMs) ||
    createdAtMs < prior.startedAtMs! - 1_000
  ) {
    throw new Error(`Tinybird job does not match the uncertain delete for ${table}`);
  }
  journal.set(key, { ...prior, jobId });
}

function normalizeDeleteCondition(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s*=\s*/g, '=') : '';
}

function parseTinybirdTimestamp(value: unknown): number {
  if (typeof value !== 'string') return Number.NaN;
  const timestamp = value.includes('T') ? value : value.replace(' ', 'T');
  return Date.parse(timestamp.endsWith('Z') ? timestamp : `${timestamp}Z`);
}

export async function validateSnapshot(
  snapshot: AgentSnapshot,
  tinybird: AgentTinybirdClient,
): Promise<void> {
  const tables = snapshot.meta('graph').facts as string[];
  for (const category of CATEGORIES) {
    const legacy = LEGACY_DATASOURCES[category as keyof typeof LEGACY_DATASOURCES];
    for (const table of [DATASOURCES[category], legacy].filter(
      (name) => !!name && tables.includes(name),
    )) {
      const { meta } = await tinybird.sql(`SELECT * FROM ${table} LIMIT 0`);
      const rows = function* () {
        for (const record of snapshot.rows(category, table)) {
          const row = JSON.parse(record.data);
          normalized(row, meta);
          yield row;
        }
      };
      for (const _group of batches(rows())) {
        /* Validate every upload before any deletion. */
      }
    }
  }
}

export async function verifyFacts(
  snapshot: AgentSnapshot,
  tinybird: AgentTinybirdClient,
): Promise<string> {
  const org = snapshot.meta('org');
  const tables = snapshot.meta('graph').facts as string[];
  const fingerprint = createHash('sha256');
  for (const category of CATEGORIES) {
    const legacy = LEGACY_DATASOURCES[category as keyof typeof LEGACY_DATASOURCES];
    for (const table of [DATASOURCES[category], legacy].filter(
      (name) => !!name && tables.includes(name),
    )) {
      const { meta } = await tinybird.sql(`SELECT * FROM ${table} LIMIT 0`);
      let count = 0;
      let previous = '';
      for await (const row of tinybird.rows(table, org, ROW_IDENTITY_FIELDS[category])) {
        const factId = ROW_IDENTITY_FIELDS[category].map((key) => row[key]).join('\x1f');
        if (factId === previous) throw new Error(`Duplicate identity remains in ${table}`);
        previous = factId;
        const expected = snapshot.get(category, factId);
        if (
          !expected ||
          JSON.stringify(normalized(JSON.parse(expected.data), meta)) !==
            JSON.stringify(normalized(row, meta))
        ) {
          throw new Error(`Stored fact mismatch in ${table}; ingestion remains paused`);
        }
        fingerprint.update(JSON.stringify([table, factId, normalized(row, meta)]) + '\n');
        count++;
      }
      const expectedCount = snapshot.db
        .query<
          { count: number },
          [string, string]
        >('SELECT count(*) AS count FROM targets WHERE category=? AND datasource=?')
        .get(category, table)!.count;
      if (count !== expectedCount)
        throw new Error(`Fact count mismatch in ${table}: ${count}/${expectedCount}`);
    }
  }
  return fingerprint.digest('hex');
}

export async function rebuild(
  snapshot: AgentSnapshot,
  tinybird: AgentTinybirdClient,
  recovery: AgentRecoveryClient,
  journal: RebuildJournal,
  reason: string,
  backupSha256: string,
): Promise<void> {
  const operationId = snapshot.meta('operationId');
  const { facts, derived } = snapshot.meta('graph') as { facts: string[]; derived: string[] };
  // Every source and every dependent aggregate is cleared before the first append.
  for (const table of [...facts, ...derived]) {
    const key = `delete:${table}`;
    const prior = journal.get(key);
    if (prior?.status === 'done') continue;
    let jobId = prior?.jobId;
    let startedAtMs = prior?.startedAtMs;
    if (prior && !jobId)
      throw new Error(`Uncertain delete ${table}; inspect Tinybird jobs before resuming`);
    if (!jobId) {
      await requireQuiescent(recovery, operationId, reason);
      startedAtMs = Date.now();
      journal.set(key, { status: 'started', startedAtMs });
      const result = await tinybird.request(
        `/v0/datasources/${table}/delete`,
        new URLSearchParams({ delete_condition: `OrgId=${quote(recovery.org)}` }),
      );
      jobId = result.job_id;
      if (typeof jobId !== 'string') throw new Error(`Delete job receipt missing for ${table}`);
      journal.set(key, { status: 'started', jobId, startedAtMs });
    }
    await tinybird.waitJob(jobId);
    const count = (
      await tinybird.sql(`SELECT count() AS count FROM ${table} WHERE OrgId=${quote(recovery.org)}`)
    ).data[0]?.count;
    if (String(count) !== '0') throw new Error(`Delete not complete for ${table}`);
    journal.set(key, { status: 'done', jobId });
  }
  for (const category of CATEGORIES) {
    const legacy = LEGACY_DATASOURCES[category as keyof typeof LEGACY_DATASOURCES];
    for (const table of [DATASOURCES[category], legacy].filter(
      (name) => !!name && facts.includes(name),
    )) {
      let sequence = 0;
      const rows = function* () {
        for (const record of snapshot.rows(category, table)) yield JSON.parse(record.data) as Row;
      };
      for (const group of batches(rows())) {
        const key = `insert:${table}:${sequence++}`;
        if (journal.get(key)?.status === 'done') continue;
        if (journal.get(key)) {
          await requireQuiescent(recovery, operationId, reason);
          if (
            !(await confirmExistingInsert(
              tinybird,
              table,
              recovery.org,
              ROW_IDENTITY_FIELDS[category],
              group,
            ))
          )
            throw new Error(
              `Uncertain insert ${key}; stored rows do not exactly match the intended batch`,
            );
          journal.set(key, { status: 'done' });
          continue;
        }
        await requireQuiescent(recovery, operationId, reason);
        journal.set(key, { status: 'started' });
        const receipt = await tinybird.request(
          `/v0/events?name=${table}&wait=true`,
          group.map((row) => JSON.stringify(row)).join('\n'),
        );
        if (receipt.successful_rows !== group.length || receipt.quarantined_rows !== 0) {
          throw new Error(`Unconfirmed insert ${key}; ingestion remains paused`);
        }
        journal.set(key, { status: 'done' });
      }
    }
  }
  const fingerprint = await verifyFacts(snapshot, tinybird);
  await verifyRollups(tinybird, recovery.org);
  for (const category of CATEGORIES) {
    for (const group of batches(confirmations(snapshot, category))) {
      await recovery.call('completeFactRebuild', {
        phase: 'stage',
        operationId,
        reason,
        confirmations: group,
      });
    }
  }
  for (const [kind, field] of [
    ['repair', 'repairRecoveryConfirmations'],
    ['tinybird_insert', 'insertRecoveryConfirmations'],
  ] as const) {
    for (const group of batches(recoveryConfirmations(snapshot, kind))) {
      await recovery.call('completeFactRebuild', {
        phase: 'stage',
        operationId,
        reason,
        confirmations: [],
        [field]: group,
      });
    }
  }
  const currentGraph = await tinybird.graph(
    [...Object.values(DATASOURCES), ...Object.values(LEGACY_DATASOURCES)],
    resolve(import.meta.dir, '../..'),
  );
  if (graphFingerprint(currentGraph) !== graphFingerprint(snapshot.meta('graph')))
    throw new Error('Materialization graph changed during rebuild; ingestion remains paused');
  await requireQuiescent(recovery, operationId, reason);
  await recovery.call('completeFactRebuild', {
    phase: 'finalize',
    operationId,
    reason,
    proof: { backupSha256, canonicalFingerprint: fingerprint, legacyFingerprint: fingerprint },
  });
}

async function requireQuiescent(
  recovery: AgentRecoveryClient,
  operationId: string,
  reason: string,
): Promise<void> {
  const result = await recovery.call('beginFactRebuild', { operationId, reason });
  if (result.status !== 'quiescent') throw new Error('Repair executor is no longer quiescent');
}
