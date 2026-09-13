#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import {
  assertSameCanonicalFence,
  assertCurrentCanonicalWindow,
  canonicalDeliveryFence,
  currentCanonicalIndex,
  type CanonicalHashIndex,
} from './agent-canonical-index';
import { exportCanonicalHashIndex } from './agent-canonical-export';
import { FrozenRecoveryJournal } from './agent-frozen-journal';
import {
  assertFrozenRecoveryTarget,
  censusSha256,
  inspectMissingCensus,
  recoverReadyFacts,
} from './agent-frozen-recovery';
import { verifyAllFrozenFacts } from './agent-frozen-verification';
import {
  requireAgentProducerMaintenance,
  requireDrainedAgentQueues,
  startMigrationRuntime,
} from './agent-migration-runtime';
import { AgentRecoveryClient } from './agent-transport';

const { values } = parseArgs({
  options: {
    org: { type: 'string' },
    census: { type: 'string' },
    journal: { type: 'string' },
    apply: { type: 'boolean', default: false },
    'confirm-org': { type: 'string' },
    'verify-all-frozen': { type: 'boolean', default: false },
    'canonical-index': { type: 'string' },
  },
});

if (!values.org || !/^[A-Za-z0-9_-]{1,256}$/.test(values.org)) {
  throw new Error('Use --org with one valid organization ID');
}
if (
  values['verify-all-frozen'] &&
  (values.apply || values.census || values.journal || !values['canonical-index'])
) {
  throw new Error(
    '--verify-all-frozen requires --canonical-index and does not accept census or journal options',
  );
}
if (
  !values['verify-all-frozen'] &&
  (!values.census || !values.journal || values['canonical-index'])
) {
  throw new Error('Targeted recovery requires --census and --journal');
}
if (values.apply && values['confirm-org'] !== values.org) {
  throw new Error('Apply requires --confirm-org matching --org');
}

const runtime = await startMigrationRuntime();
let journal: FrozenRecoveryJournal | undefined;
let canonicalIndex: CanonicalHashIndex | undefined;
try {
  const recovery = new AgentRecoveryClient(values.org, runtime.url);
  await assertFrozenRecoveryTarget(recovery, runtime.tb);
  if (values['verify-all-frozen']) {
    await requireAgentProducerMaintenance();
    await requireDrainedAgentQueues();
    const sequence = canonicalDeliveryFence(await recovery.call('inspectIngestionMigration', {}));
    canonicalIndex = currentCanonicalIndex(
      resolve(values['canonical-index']!),
      values.org,
      runtime.tb.host,
    );
    canonicalIndex.beginExport(sequence);
    await exportCanonicalHashIndex(runtime.tb, canonicalIndex);
    assertSameCanonicalFence(sequence, await recovery.call('inspectIngestionMigration', {}));
    canonicalIndex.finishExport(sequence);
    const report = await verifyAllFrozenFacts(recovery, canonicalIndex);
    assertSameCanonicalFence(sequence, await recovery.call('inspectIngestionMigration', {}));
    assertCurrentCanonicalWindow(canonicalIndex);
    console.log(
      JSON.stringify({
        mode: 'verify-all-frozen',
        org: values.org,
        canonicalDeliverySequence: sequence,
        retentionWindow: {
          oldestDay: canonicalIndex.oldestDay,
          todayDay: canonicalIndex.todayDay,
        },
        ...report,
        note: 'Legacy ledger retirement requires zero missing and zero conflicts. Exact matches compare every typed source column including IngestedAt; newer canonical rows are preserved.',
      }),
    );
  } else {
    const censusPath = resolve(values.census!);
    const journalPath = resolve(values.journal!);
    journal = new FrozenRecoveryJournal(journalPath, values.org, await censusSha256(censusPath));
    await inspectMissingCensus(censusPath, values.org, recovery, journal, runtime.tb);
    if (values.apply) await recoverReadyFacts(recovery, journal, runtime.tb, values.org);
    console.log(
      JSON.stringify({
        mode: values.apply ? 'apply' : 'read-only',
        org: values.org,
        ...journal.report(),
        note: 'This local missing-identity subset is not proof that the complete frozen ledger can be retired. Run --verify-all-frozen after recovery.',
      }),
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Frozen recovery failed');
  process.exitCode = 1;
} finally {
  canonicalIndex?.close();
  journal?.close();
  runtime.close();
}
