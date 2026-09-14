import type { Category } from './facts';

export interface BaselineCopyFailedAttempt {
  copyAttempt: number;
  jobId: string;
  status: 'error';
  observedAt: number;
  providerErrorSha256: string;
  journalSha256: string;
}

export interface BaselineCopyCheckpoint {
  category: Category;
  startDay: string;
  endDay: string;
  startedAt: number;
  copyAttempt: number;
  jobId?: string;
  complete: boolean;
  failedAttempt?: BaselineCopyFailedAttempt;
}

export interface BaselineMigrationWindow {
  startDay: string;
  endDay: string;
}

export type BeginBaselineCopyInput = Omit<
  BaselineCopyCheckpoint,
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
