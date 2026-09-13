import type { Category } from './facts';

export interface BaselineCopyCheckpoint {
  category: Category;
  startDay: string;
  endDay: string;
  startedAt: number;
  copyAttempt: number;
  jobId?: string;
  complete: boolean;
}

export interface BaselineMigrationWindow {
  startDay: string;
  endDay: string;
}
