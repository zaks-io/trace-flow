import { CATEGORIES, type Category } from './facts';

import { assertExactKeys } from './agent-delivery-coordinator-validation';
import type {
  BaselineCopyCheckpoint,
  BaselineMigrationWindow,
  BeginBaselineCopyInput,
  ConfirmBaselineCopyInput,
  RetryBaselineCopyInput,
} from './baseline-copy-contract';
export type {
  BaselineCopyCheckpoint,
  BaselineMigrationWindow,
  BeginBaselineCopyInput,
  ConfirmBaselineCopyInput,
  RetryBaselineCopyInput,
} from './baseline-copy-contract';
const key = (category: Category) => `baseline-copy:${category}`;
const WINDOW_KEY = 'baseline-copy-window';

function validateWindow(input: BaselineMigrationWindow): BaselineMigrationWindow {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(input.startDay) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(input.endDay) ||
    input.startDay > input.endDay
  ) {
    throw new Error('Invalid baseline Copy window');
  }
  return { startDay: input.startDay, endDay: input.endDay };
}

export async function baselineMigrationWindow(
  storage: Pick<DurableObjectStorage, 'get'>,
): Promise<BaselineMigrationWindow | null> {
  return (await storage.get<BaselineMigrationWindow>(WINDOW_KEY)) ?? null;
}

export async function beginBaselineMigrationWindow(
  storage: DurableObjectStorage,
  input: BaselineMigrationWindow,
): Promise<BaselineMigrationWindow> {
  const window = validateWindow(input);
  return storage.transaction(async (transaction) => {
    const existing = await baselineMigrationWindow(transaction);
    if (existing) return existing;
    await transaction.put(WINDOW_KEY, window);
    return window;
  });
}

export async function baselineCopyCheckpoint(
  storage: Pick<DurableObjectStorage, 'get'>,
  category: Category,
): Promise<BaselineCopyCheckpoint | null> {
  if (!CATEGORIES.includes(category)) throw new Error('Invalid baseline category');
  return (await storage.get<BaselineCopyCheckpoint>(key(category))) ?? null;
}

export async function beginBaselineCopy(
  storage: DurableObjectStorage,
  input: BeginBaselineCopyInput,
): Promise<BaselineCopyCheckpoint & { created: boolean }> {
  if (
    !CATEGORIES.includes(input.category) ||
    !Number.isSafeInteger(input.startedAt) ||
    input.startedAt <= 0 ||
    !Number.isSafeInteger(input.copyAttempt) ||
    input.copyAttempt <= 0 ||
    !/^\d{4}-\d{2}-\d{2}$/.test(input.startDay) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(input.endDay) ||
    input.startDay > input.endDay
  ) {
    throw new Error('Invalid baseline Copy intent');
  }
  return storage.transaction(async (transaction) => {
    const existing = await baselineCopyCheckpoint(transaction, input.category);
    if (existing) {
      if (existing.startDay !== input.startDay || existing.endDay !== input.endDay)
        throw new Error('Baseline Copy window changed');
      return { ...existing, created: false };
    }
    const intent = {
      category: input.category,
      startDay: input.startDay,
      endDay: input.endDay,
      startedAt: input.startedAt,
      copyAttempt: input.copyAttempt,
      complete: false,
    };
    await transaction.put(key(input.category), intent);
    return { ...intent, created: true };
  });
}

export async function confirmBaselineCopy(
  storage: DurableObjectStorage,
  input: ConfirmBaselineCopyInput,
): Promise<BaselineCopyCheckpoint> {
  assertExactKeys(input, ['category', 'copyAttempt', 'jobId', 'complete'], 'confirm baseline Copy');
  if (
    !Number.isSafeInteger(input.copyAttempt) ||
    input.copyAttempt <= 0 ||
    !/^[a-zA-Z0-9-]{1,128}$/.test(input.jobId) ||
    typeof input.complete !== 'boolean'
  )
    throw new Error('Invalid baseline Copy confirmation');
  return storage.transaction(async (transaction) => {
    const existing = await baselineCopyCheckpoint(transaction, input.category);
    if (
      existing?.copyAttempt !== input.copyAttempt ||
      (existing?.jobId !== undefined && existing.jobId !== input.jobId)
    )
      throw new Error('Baseline Copy confirmation conflict');
    const checkpoint = {
      ...existing,
      jobId: input.jobId,
      complete: existing.complete || input.complete,
    };
    await transaction.put(key(input.category), checkpoint);
    return checkpoint;
  });
}

export async function retryBaselineCopy(
  storage: DurableObjectStorage,
  input: RetryBaselineCopyInput,
): Promise<BaselineCopyCheckpoint> {
  assertExactKeys(
    input,
    [
      'category',
      'expectedJobId',
      'expectedCopyAttempt',
      'nextCopyAttempt',
      'observedAt',
      'providerErrorSha256',
      'journalSha256',
    ],
    'retry baseline Copy',
  );
  if (
    !CATEGORIES.includes(input.category) ||
    !/^[a-zA-Z0-9-]{1,128}$/.test(input.expectedJobId) ||
    !Number.isSafeInteger(input.expectedCopyAttempt) ||
    input.expectedCopyAttempt <= 0 ||
    !Number.isSafeInteger(input.nextCopyAttempt) ||
    input.nextCopyAttempt <= input.expectedCopyAttempt ||
    !Number.isSafeInteger(input.observedAt) ||
    input.observedAt <= 0 ||
    !/^[0-9a-f]{64}$/.test(input.providerErrorSha256) ||
    !/^[0-9a-f]{64}$/.test(input.journalSha256)
  ) {
    throw new Error('Invalid baseline Copy retry proof');
  }
  return storage.transaction(async (transaction) => {
    const existing = await baselineCopyCheckpoint(transaction, input.category);
    if (
      !existing ||
      existing.complete ||
      existing.failedAttempt ||
      existing.jobId !== input.expectedJobId ||
      existing.copyAttempt !== input.expectedCopyAttempt
    ) {
      throw new Error('Baseline Copy retry conflict');
    }
    const { jobId, ...checkpoint } = existing;
    const retry = {
      ...checkpoint,
      copyAttempt: input.nextCopyAttempt,
      failedAttempt: {
        copyAttempt: input.expectedCopyAttempt,
        jobId,
        status: 'error' as const,
        observedAt: input.observedAt,
        providerErrorSha256: input.providerErrorSha256,
        journalSha256: input.journalSha256,
      },
    };
    await transaction.put(key(input.category), retry);
    return retry;
  });
}
