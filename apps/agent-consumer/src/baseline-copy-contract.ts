import type { Category } from './facts';

export interface BaselineCopyFailedAttempt {
  copyAttempt: number;
  jobId: string;
  status: 'error';
  observedAt: number;
  providerErrorSha256: string;
  journalSha256: string;
}

export interface LegacyBaselineCopyCheckpoint {
  category: Category;
  startDay: string;
  endDay: string;
  startedAt: number;
  copyAttempt: number;
  jobId?: string;
  complete: boolean;
  failedAttempt?: BaselineCopyFailedAttempt;
}

export interface BaselineCopyDailyStat {
  day: string;
  rows: number;
  projectedBytes: number;
}

export interface BaselineCopyChunk {
  startDay: string;
  endDay: string;
  rows: number;
  projectedBytes: number;
}

export interface BaselineCopyPlan {
  sha256: string;
  dailyStats: BaselineCopyDailyStat[];
  chunks: BaselineCopyChunk[];
  totalRows: number;
  totalProjectedBytes: number;
}

export interface BaselineCopyJobReceipt {
  copyAttempt: number;
  jobId: string;
}

export interface BoundedBaselineCopyCheckpoint {
  mode: 'bounded';
  category: Category;
  startDay: string;
  endDay: string;
  startedAt: number;
  plan: BaselineCopyPlan;
  completedJobs: BaselineCopyJobReceipt[];
  activeJob?: { copyAttempt: number; jobId?: string };
  complete: boolean;
  completion?: { proofSha256: string; completedAt: number; lastJobId: string };
  legacy?: {
    checkpoint: LegacyBaselineCopyCheckpoint;
    currentFailure: BaselineCopyFailedAttempt;
  };
}

export type BaselineCopyCheckpoint = LegacyBaselineCopyCheckpoint | BoundedBaselineCopyCheckpoint;

export interface BaselineMigrationWindow {
  startDay: string;
  endDay: string;
}

export type BeginBaselineCopyInput = Omit<
  LegacyBaselineCopyCheckpoint,
  'jobId' | 'complete' | 'failedAttempt'
>;

export interface ConfirmBaselineCopyInput {
  category: Category;
  copyAttempt: number;
  jobId: string;
  complete: boolean;
}

export interface RetryBaselineCopyInput {
  category: Category;
  expectedJobId: string;
  expectedCopyAttempt: number;
  nextCopyAttempt: number;
  observedAt: number;
  providerErrorSha256: string;
  journalSha256: string;
}

export interface BeginBoundedBaselineCopyInput {
  category: Category;
  startDay: string;
  endDay: string;
  startedAt: number;
  plan: BaselineCopyPlan;
  legacyFailure?: {
    expectedJobId: string;
    expectedCopyAttempt: number;
    observedAt: number;
    providerErrorSha256: string;
    journalSha256: string;
  };
}

export interface BaselineCopyChunkInput {
  category: Category;
  planSha256: string;
  chunkIndex: number;
  copyAttempt: number;
}

export interface ConfirmBaselineCopyChunkInput extends BaselineCopyChunkInput {
  jobId: string;
}

export interface CompleteBoundedBaselineCopyInput {
  category: Category;
  planSha256: string;
  proofSha256: string;
  completedAt: number;
}
