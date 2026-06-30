import { describe, expect, it } from 'vitest';
import {
  buildSandboxControlEvents,
  isActiveSandboxRunStatus,
  planDeadRunRecovery,
  shouldScheduleContinuation,
  SANDBOX_MAX_RESUME_ATTEMPTS,
} from '../analystSandboxPolicy';

// The timeout/liveness/cause predicates are exercised in analyst.test.ts (their
// original assertions). This file owns the decision logic lifted out of the
// ctx-bound handlers: the auto-resume cap, continuation gating, and control-event
// projection.

describe('planDeadRunRecovery', () => {
  it('resumes with an incremented attempt on the first deaths', () => {
    expect(planDeadRunRecovery({})).toEqual({ action: 'resume', resumeAttempt: 1 });
    expect(planDeadRunRecovery({ resumeAttempt: 1 })).toEqual({
      action: 'resume',
      resumeAttempt: 2,
    });
  });

  it('gives up once the resume cap is reached', () => {
    expect(planDeadRunRecovery({ resumeAttempt: SANDBOX_MAX_RESUME_ATTEMPTS })).toEqual({
      action: 'give_up',
      attempts: SANDBOX_MAX_RESUME_ATTEMPTS,
    });
  });

  it('never resumes past the cap even if the stored attempt overshot', () => {
    expect(planDeadRunRecovery({ resumeAttempt: 99 })).toEqual({ action: 'give_up', attempts: 99 });
  });
});

describe('shouldScheduleContinuation', () => {
  it('schedules a fresh completed run with result text', () => {
    expect(shouldScheduleContinuation({ status: 'completed', resultText: 'done' })).toBe(true);
  });

  it('does not schedule without result text', () => {
    expect(shouldScheduleContinuation({ status: 'completed' })).toBe(false);
    expect(shouldScheduleContinuation({ status: 'completed', resultText: '' })).toBe(false);
  });

  it('does not schedule non-completed runs', () => {
    expect(shouldScheduleContinuation({ status: 'failed', resultText: 'x' })).toBe(false);
    expect(shouldScheduleContinuation({ status: 'running', resultText: 'x' })).toBe(false);
  });

  it('does not double-schedule', () => {
    expect(
      shouldScheduleContinuation({
        status: 'completed',
        resultText: 'done',
        continuationScheduledAt: 1,
      }),
    ).toBe(false);
  });
});

describe('buildSandboxControlEvents', () => {
  it('emits a not_found stderr when there is no process', () => {
    const events = buildSandboxControlEvents({ processId: 'pi-1' }, { process: null });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('stderr');
    expect(events[0].message).toContain('was not found');
  });

  it('emits a status line plus stdout/stderr/diagnostics tails', () => {
    const events = buildSandboxControlEvents(
      { processId: 'pi-1' },
      {
        process: { id: 'pi-1', status: 'running', exitCode: 0 },
        logs: {
          stdout: { value: 'out', truncated: false },
          stderr: { value: 'err', truncated: true },
        },
        diagnostics: ['  diag  ', '   '],
      },
    );
    expect(events.map((e) => e.type)).toEqual(['status', 'stdout', 'stderr', 'stderr']);
    expect(events[0].message).toContain('is running with exit code 0');
    expect(events[3].message).toBe('diag');
  });
});

describe('isActiveSandboxRunStatus', () => {
  it('matches only the active statuses', () => {
    for (const s of ['queued', 'starting', 'running'])
      expect(isActiveSandboxRunStatus(s)).toBe(true);
    for (const s of ['completed', 'failed', 'timed_out', 'cancelled'])
      expect(isActiveSandboxRunStatus(s)).toBe(false);
  });
});
