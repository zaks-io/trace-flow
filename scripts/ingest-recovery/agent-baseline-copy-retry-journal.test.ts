import { describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preserveBaselineCopyFailure } from './agent-baseline-copy-retry-journal';

describe('baseline Copy retry journal', () => {
  test('keeps the first full provider record while concurrent runners share its hash', () => {
    const root = mkdtempSync(join(tmpdir(), 'baseline-copy-retry-journal-'));
    const checkpoint = {
      category: 'tool_events' as const,
      startDay: '2026-09-01',
      endDay: '2026-09-13',
      startedAt: 1,
      copyAttempt: 1,
      jobId: 'job-failed',
      complete: false,
    };
    const fsync = spyOn(fs, 'fsyncSync');
    try {
      const first = preserveBaselineCopyFailure(root, {
        version: 1,
        orgId: 'org-proof',
        checkpoint,
        observedAt: 10,
        providerJob: {
          job_id: 'job-failed',
          status: 'error',
          error: 'Copy timed out',
          query_sql: 'first full provider record',
        },
      });
      expect(fsync).toHaveBeenCalledTimes(2);
      const second = preserveBaselineCopyFailure(root, {
        version: 1,
        orgId: 'org-proof',
        checkpoint,
        observedAt: 11,
        providerJob: {
          job_id: 'job-failed',
          status: 'error',
          error: 'Copy timed out',
          query_sql: 'same terminal job fetched again',
        },
      });

      expect(second).toEqual(first);
      expect(fsync).toHaveBeenCalledTimes(4);
      expect(readFileSync(join(root, 'tool_events-job-failed.json'), 'utf8')).toContain(
        'first full provider record',
      );
    } finally {
      fsync.mockRestore();
      rmSync(root, { recursive: true });
    }
  });
});
