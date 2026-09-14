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
import {
  assertCompletedRetirement,
  existingRetirement,
  recordedRetirementProof,
  retirementProof,
} from './agent-frozen-retirement';
import { verifyAllFrozenFacts } from './agent-frozen-verification';
import { FrozenRepairReconciliationJournal } from './agent-frozen-repair-journal';
import { reconcileAllFrozenRepairs } from './agent-frozen-repair-reconciliation';
import {
  requireAgentProducerMaintenance,
  requireDrainedAgentQueues,
  startMigrationRuntime,
} from './agent-migration-runtime';
import { verifyMigrationTarget } from './agent-migration-target';
import { AgentRecoveryClient } from './agent-transport';

const { values } = parseArgs({
  options: {
    org: { type: 'string' },
    census: { type: 'string' },
    journal: { type: 'string' },
    apply: { type: 'boolean', default: false },
    'confirm-org': { type: 'string' },
    'verify-all-frozen': { type: 'boolean', default: false },
    'reconcile-blocked-repairs': { type: 'boolean', default: false },
    retire: { type: 'boolean', default: false },
    'canonical-index': { type: 'string' },
  },
});

if (!values.org || !/^[A-Za-z0-9_-]{1,256}$/.test(values.org)) {
  throw new Error('Use --org with one valid organization ID');
}
if (
  [values.retire, values['verify-all-frozen'], values['reconcile-blocked-repairs']].filter(Boolean)
    .length > 1
) {
  throw new Error('Use one of --retire, --verify-all-frozen, or --reconcile-blocked-repairs');
}
if (values.retire) {
  if (
    !values.apply ||
    values['confirm-org'] !== values.org ||
    !values['canonical-index'] ||
    values.census ||
    values.journal
  ) {
    throw new Error(
      '--retire requires --apply, exact --confirm-org, and --canonical-index without census or journal options',
    );
  }
} else if (values['reconcile-blocked-repairs']) {
  if (
    !values.apply ||
    values['confirm-org'] !== values.org ||
    !values['canonical-index'] ||
    !values.journal ||
    values.census
  ) {
    throw new Error(
      '--reconcile-blocked-repairs requires --apply, exact --confirm-org, --canonical-index, and --journal without a census',
    );
  }
} else if (
  values['verify-all-frozen'] &&
  (values.apply || values.census || values.journal || !values['canonical-index'])
) {
  throw new Error(
    '--verify-all-frozen requires --canonical-index and does not accept census or journal options',
  );
}
if (
  !values.retire &&
  !values['verify-all-frozen'] &&
  !values['reconcile-blocked-repairs'] &&
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
let repairJournal: FrozenRepairReconciliationJournal | undefined;
try {
  const recovery = new AgentRecoveryClient(values.org, runtime.url);
  if (values['verify-all-frozen'] || values.retire || values['reconcile-blocked-repairs']) {
    await requireAgentProducerMaintenance();
    await requireDrainedAgentQueues();
    const initialState = await recovery.call('inspectIngestionMigration', {});
    await verifyMigrationTarget(runtime.tb, initialState?.migrationTarget);
    const priorRetirement = values.retire ? existingRetirement(initialState) : null;
    if (priorRetirement) {
      const proof = recordedRetirementProof(priorRetirement);
      const completed = assertCompletedRetirement(
        await recovery.call('retireFrozenLedger', proof),
        proof,
      );
      console.log(
        JSON.stringify({
          mode: 'retire-resume',
          org: values.org,
          retirement: completed,
          note: 'Retirement resumed from the matching durable external intent created by a prior full verification.',
        }),
      );
    } else {
      const frozenState = await assertFrozenRecoveryTarget(recovery, runtime.tb);
      const sequence = canonicalDeliveryFence(frozenState);
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
      const finalState = await recovery.call('inspectIngestionMigration', {});
      assertSameCanonicalFence(sequence, finalState);
      assertCurrentCanonicalWindow(canonicalIndex);
      if (values['reconcile-blocked-repairs'] && !report.eligibleForLegacyRetirement) {
        throw new Error('Full frozen verification found missing or conflicting retained facts');
      }
      if (values['reconcile-blocked-repairs']) {
        const migrationProofSha256 = finalState?.migration?.proofSha256;
        if (
          typeof migrationProofSha256 !== 'string' ||
          !/^[a-f0-9]{64}$/.test(migrationProofSha256)
        ) {
          throw new Error('Completed ingestion migration proof is unavailable');
        }
        const fence = {
          migrationProofSha256,
          deliverySequence: sequence,
          fullVerificationSha256: report.verificationSha256,
        };
        repairJournal = new FrozenRepairReconciliationJournal(resolve(values.journal!), {
          orgId: values.org,
          ...fence,
          oldestDay: canonicalIndex.oldestDay,
          todayDay: canonicalIndex.todayDay,
        });
        const reconciliation = await reconcileAllFrozenRepairs(
          recovery,
          canonicalIndex,
          fence,
          repairJournal,
        );
        const reconciledState = await recovery.call('inspectIngestionMigration', {});
        assertSameCanonicalFence(sequence, reconciledState);
        assertCurrentCanonicalWindow(canonicalIndex);
        if (reconciledState?.legacy?.blockedRecoveryRecords !== 0) {
          throw new Error('Blocked recovery records remain after frozen repair reconciliation');
        }
        const finalVerification = await verifyAllFrozenFacts(recovery, canonicalIndex);
        if (
          !finalVerification.eligibleForLegacyRetirement ||
          finalVerification.verificationSha256 !== report.verificationSha256
        ) {
          throw new Error('Frozen ledger changed after repair reconciliation');
        }
        console.log(
          JSON.stringify({
            mode: 'reconcile-blocked-repairs',
            org: values.org,
            canonicalDeliverySequence: sequence,
            retentionWindow: {
              oldestDay: canonicalIndex.oldestDay,
              todayDay: canonicalIndex.todayDay,
            },
            reconciliation,
            verificationBeforeReconciliation: report,
            verificationAfterReconciliation: finalVerification,
            note: 'Every blocked repair was durably preserved in the private journal, resolved against the complete frozen verification fence, and removed from recovery payload storage. Preserve the journal. Legacy retirement remains a separate operation.',
          }),
        );
      } else {
        const proof = values.retire
          ? retirementProof(report, canonicalIndex, finalState)
          : undefined;
        const retirement = proof
          ? assertCompletedRetirement(await recovery.call('retireFrozenLedger', proof), proof)
          : undefined;
        console.log(
          JSON.stringify({
            mode: values.retire ? 'retire' : 'verify-all-frozen',
            org: values.org,
            canonicalDeliverySequence: sequence,
            retentionWindow: {
              oldestDay: canonicalIndex.oldestDay,
              todayDay: canonicalIndex.todayDay,
            },
            ...report,
            ...(retirement ? { retirement } : {}),
            note: retirement
              ? 'The verified frozen legacy ledger was retired; the coordinator, canonical facts, delivery objects, R2 buffers, and shared DLQ were not deleted.'
              : 'Legacy ledger retirement requires zero missing and zero conflicts. Exact matches compare every typed source column including IngestedAt; newer canonical rows are preserved.',
          }),
        );
      }
    }
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
  repairJournal?.close();
  journal?.close();
  runtime.close();
}
