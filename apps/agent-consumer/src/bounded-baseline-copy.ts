import { sha256Hex } from '@trace-flow/utils';
import { assertExactKeys } from './agent-delivery-coordinator-validation';
import type {
  BaselineCopyCheckpoint,
  BaselineCopyChunkInput,
  BeginBoundedBaselineCopyInput,
  BoundedBaselineCopyCheckpoint,
  CompleteBoundedBaselineCopyInput,
  ConfirmBaselineCopyChunkInput,
} from './baseline-copy-contract';
import {
  baselineCopyPlanHashInput,
  isBoundedBaselineCopy,
  requireBoundedCheckpointSize,
  validateBaselineCopyPlan,
} from './baseline-copy-plan';
import { baselineCopyCheckpoint } from './baseline-copy-migration';

const key = (category: BaselineCopyCheckpoint['category']) => `baseline-copy:${category}`;

export async function beginBoundedBaselineCopy(
  storage: DurableObjectStorage,
  input: BeginBoundedBaselineCopyInput,
): Promise<BoundedBaselineCopyCheckpoint & { created: boolean }> {
  validateBeginInput(input);
  validateBaselineCopyPlan(input.category, input.startDay, input.endDay, input.plan);
  if (
    (await sha256Hex(
      baselineCopyPlanHashInput(input.category, input.startDay, input.endDay, input.plan),
    )) !== input.plan.sha256
  ) {
    throw new Error('Bounded baseline Copy plan hash mismatch');
  }
  return storage.transaction(async (transaction) => {
    const existing = await baselineCopyCheckpoint(transaction, input.category);
    if (existing && isBoundedBaselineCopy(existing)) {
      if (
        existing.startDay !== input.startDay ||
        existing.endDay !== input.endDay ||
        existing.plan.sha256 !== input.plan.sha256
      ) {
        throw new Error('Bounded baseline Copy plan conflict');
      }
      return { ...existing, created: false };
    }

    let legacy: BoundedBaselineCopyCheckpoint['legacy'];
    if (existing) {
      const failure = input.legacyFailure;
      if (
        !failure ||
        existing.complete ||
        existing.jobId !== failure.expectedJobId ||
        existing.copyAttempt !== failure.expectedCopyAttempt ||
        existing.failedAttempt?.jobId === failure.expectedJobId ||
        existing.startDay !== input.startDay ||
        existing.endDay !== input.endDay ||
        existing.startedAt !== input.startedAt
      ) {
        throw new Error('Bounded baseline Copy legacy transition conflict');
      }
      legacy = {
        checkpoint: existing,
        currentFailure: {
          copyAttempt: failure.expectedCopyAttempt,
          jobId: failure.expectedJobId,
          status: 'error',
          observedAt: failure.observedAt,
          providerErrorSha256: failure.providerErrorSha256,
          journalSha256: failure.journalSha256,
        },
      };
    } else if (input.legacyFailure) {
      throw new Error('Bounded baseline Copy has no legacy checkpoint to archive');
    }

    const checkpoint: BoundedBaselineCopyCheckpoint = {
      mode: 'bounded',
      category: input.category,
      startDay: input.startDay,
      endDay: input.endDay,
      startedAt: input.startedAt,
      plan: input.plan,
      completedJobs: [],
      complete: false,
      ...(legacy ? { legacy } : {}),
    };
    requireBoundedCheckpointSize(checkpoint);
    await transaction.put(key(input.category), checkpoint);
    return { ...checkpoint, created: true };
  });
}

export async function armBoundedBaselineCopyChunk(
  storage: DurableObjectStorage,
  input: BaselineCopyChunkInput,
): Promise<BoundedBaselineCopyCheckpoint & { created: boolean }> {
  validateChunkInput(input);
  return storage.transaction(async (transaction) => {
    const existing = await requireCurrentPlan(transaction, input);
    if (existing.complete || input.chunkIndex !== existing.completedJobs.length) {
      throw new Error('Bounded baseline Copy chunk cursor conflict');
    }
    if (existing.activeJob) {
      if (existing.activeJob.copyAttempt !== input.copyAttempt) {
        throw new Error('Bounded baseline Copy chunk intent conflict');
      }
      return { ...existing, created: false };
    }
    const checkpoint = { ...existing, activeJob: { copyAttempt: input.copyAttempt } };
    requireBoundedCheckpointSize(checkpoint);
    await transaction.put(key(input.category), checkpoint);
    return { ...checkpoint, created: true };
  });
}

export async function confirmBoundedBaselineCopyChunk(
  storage: DurableObjectStorage,
  input: ConfirmBaselineCopyChunkInput,
): Promise<BoundedBaselineCopyCheckpoint> {
  validateChunkInput(input);
  requireJobId(input.jobId);
  return storage.transaction(async (transaction) => {
    const existing = await requireCurrentPlan(transaction, input);
    const completed = existing.completedJobs[input.chunkIndex];
    if (completed) {
      if (completed.copyAttempt === input.copyAttempt && completed.jobId === input.jobId) {
        return existing;
      }
      throw new Error('Bounded baseline Copy chunk completion conflict');
    }
    if (
      existing.complete ||
      input.chunkIndex !== existing.completedJobs.length ||
      existing.activeJob?.copyAttempt !== input.copyAttempt ||
      (existing.activeJob.jobId !== undefined && existing.activeJob.jobId !== input.jobId)
    ) {
      throw new Error('Bounded baseline Copy chunk receipt conflict');
    }
    const checkpoint = { ...existing, activeJob: { ...existing.activeJob, jobId: input.jobId } };
    requireBoundedCheckpointSize(checkpoint);
    await transaction.put(key(input.category), checkpoint);
    return checkpoint;
  });
}

export async function completeBoundedBaselineCopyChunk(
  storage: DurableObjectStorage,
  input: ConfirmBaselineCopyChunkInput,
): Promise<BoundedBaselineCopyCheckpoint> {
  validateChunkInput(input);
  requireJobId(input.jobId);
  return storage.transaction(async (transaction) => {
    const existing = await requireCurrentPlan(transaction, input);
    const completed = existing.completedJobs[input.chunkIndex];
    if (completed) {
      if (completed.copyAttempt === input.copyAttempt && completed.jobId === input.jobId) {
        return existing;
      }
      throw new Error('Bounded baseline Copy chunk completion conflict');
    }
    if (
      existing.complete ||
      input.chunkIndex !== existing.completedJobs.length ||
      existing.activeJob?.copyAttempt !== input.copyAttempt ||
      existing.activeJob.jobId !== input.jobId
    ) {
      throw new Error('Bounded baseline Copy chunk completion conflict');
    }
    const checkpoint: BoundedBaselineCopyCheckpoint = {
      ...existing,
      completedJobs: [
        ...existing.completedJobs,
        { copyAttempt: input.copyAttempt, jobId: input.jobId },
      ],
    };
    delete checkpoint.activeJob;
    requireBoundedCheckpointSize(checkpoint);
    await transaction.put(key(input.category), checkpoint);
    return checkpoint;
  });
}

export async function completeBoundedBaselineCopy(
  storage: DurableObjectStorage,
  input: CompleteBoundedBaselineCopyInput,
): Promise<BoundedBaselineCopyCheckpoint> {
  assertExactKeys(
    input,
    ['category', 'planSha256', 'proofSha256', 'completedAt'],
    'complete bounded baseline Copy',
  );
  if (!hash(input.planSha256) || !hash(input.proofSha256) || !positiveInteger(input.completedAt)) {
    throw new Error('Invalid bounded baseline Copy completion');
  }
  return storage.transaction(async (transaction) => {
    const existing = await baselineCopyCheckpoint(transaction, input.category);
    if (
      !existing ||
      !isBoundedBaselineCopy(existing) ||
      existing.plan.sha256 !== input.planSha256 ||
      existing.activeJob ||
      existing.completedJobs.length !== existing.plan.chunks.length
    ) {
      throw new Error('Bounded baseline Copy completion conflict');
    }
    if (existing.complete) {
      if (
        existing.completion?.proofSha256 !== input.proofSha256 ||
        existing.completion.completedAt !== input.completedAt
      ) {
        throw new Error('Bounded baseline Copy completion conflict');
      }
      return existing;
    }
    const lastJobId = existing.completedJobs.at(-1)?.jobId;
    if (!lastJobId) throw new Error('Bounded baseline Copy has no completed jobs');
    const checkpoint: BoundedBaselineCopyCheckpoint = {
      ...existing,
      complete: true,
      completion: { proofSha256: input.proofSha256, completedAt: input.completedAt, lastJobId },
    };
    requireBoundedCheckpointSize(checkpoint);
    await transaction.put(key(input.category), checkpoint);
    return checkpoint;
  });
}

async function requireCurrentPlan(
  storage: Pick<DurableObjectStorage, 'get'>,
  input: BaselineCopyChunkInput,
): Promise<BoundedBaselineCopyCheckpoint> {
  const checkpoint = await baselineCopyCheckpoint(storage, input.category);
  if (
    !checkpoint ||
    !isBoundedBaselineCopy(checkpoint) ||
    checkpoint.plan.sha256 !== input.planSha256
  ) {
    throw new Error('Bounded baseline Copy plan conflict');
  }
  if (input.chunkIndex < 0 || input.chunkIndex >= checkpoint.plan.chunks.length) {
    throw new Error('Bounded baseline Copy chunk index is out of range');
  }
  return checkpoint;
}

function validateBeginInput(input: BeginBoundedBaselineCopyInput): void {
  assertExactKeys(
    input,
    [
      'category',
      'startDay',
      'endDay',
      'startedAt',
      'plan',
      ...('legacyFailure' in input ? ['legacyFailure'] : []),
    ],
    'begin bounded baseline Copy',
  );
  if (!positiveInteger(input.startedAt)) throw new Error('Invalid bounded baseline Copy start');
  const failure = input.legacyFailure;
  if (
    failure &&
    (!positiveInteger(failure.expectedCopyAttempt) ||
      !positiveInteger(failure.observedAt) ||
      !hash(failure.providerErrorSha256) ||
      !hash(failure.journalSha256))
  ) {
    throw new Error('Invalid bounded baseline Copy legacy failure');
  }
  if (failure) requireJobId(failure.expectedJobId);
  if (failure) {
    assertExactKeys(
      failure,
      [
        'expectedJobId',
        'expectedCopyAttempt',
        'observedAt',
        'providerErrorSha256',
        'journalSha256',
      ],
      'bounded baseline Copy legacy failure',
    );
  }
}

function validateChunkInput(input: BaselineCopyChunkInput): void {
  assertExactKeys(
    input,
    ['category', 'planSha256', 'chunkIndex', 'copyAttempt', ...('jobId' in input ? ['jobId'] : [])],
    'bounded baseline Copy chunk input',
  );
  if (
    !hash(input.planSha256) ||
    !positiveInteger(input.copyAttempt) ||
    !Number.isSafeInteger(input.chunkIndex)
  ) {
    throw new Error('Invalid bounded baseline Copy chunk input');
  }
}

function requireJobId(value: string): void {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(value)) {
    throw new Error('Invalid bounded baseline Copy job receipt');
  }
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function hash(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}
