import { createHash } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import type { BaselineCopyCheckpoint } from '../../apps/agent-consumer/src/baseline-copy-contract';

interface BaselineCopyFailureJournalEntry {
  version: 1;
  orgId: string;
  checkpoint: BaselineCopyCheckpoint;
  observedAt: number;
  providerJob: Record<string, unknown>;
}

export function preserveBaselineCopyFailure(
  root: string,
  entry: BaselineCopyFailureJournalEntry,
): { journalSha256: string; providerErrorSha256: string; observedAt: number } {
  if (!root.trim()) throw new Error('Baseline Copy retry journal root is required');
  const error = entry.providerJob.error;
  if (typeof error !== 'string' || !error) {
    throw new Error('Baseline Copy error response omitted the provider error');
  }
  const directory = resolve(root);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryMode = lstatSync(directory).mode & 0o777;
  if (directoryMode & 0o077) throw new Error('Baseline Copy retry journal root must be private');

  const content = `${canonicalJson(entry)}\n`;
  const jobId = entry.checkpoint.jobId;
  if (!jobId || !/^[a-zA-Z0-9-]{1,128}$/.test(jobId)) {
    throw new Error('Baseline Copy retry journal requires a valid job receipt');
  }
  const path = join(directory, `${entry.checkpoint.category}-${jobId}.json`);
  try {
    writeFileSync(path, content, { flag: 'wx', mode: 0o600 });
    syncFile(path);
    syncFile(directory);
  } catch (caught) {
    if (!isAlreadyExists(caught)) throw caught;
    const existing = readFileSync(path, 'utf8');
    const preserved = parsePreservedEntry(path, existing, entry);
    syncFile(path);
    syncFile(directory);
    return {
      journalSha256: sha256(existing),
      providerErrorSha256: sha256(preserved.providerJob.error as string),
      observedAt: preserved.observedAt,
    };
  }
  return {
    journalSha256: sha256(content),
    providerErrorSha256: sha256(error),
    observedAt: entry.observedAt,
  };
}

function parsePreservedEntry(
  path: string,
  content: string,
  current: BaselineCopyFailureJournalEntry,
): BaselineCopyFailureJournalEntry {
  const mode = lstatSync(path).mode;
  if (mode & 0o077) throw new Error('Baseline Copy retry journal evidence must be private');
  let preserved: BaselineCopyFailureJournalEntry;
  try {
    preserved = JSON.parse(content) as BaselineCopyFailureJournalEntry;
  } catch {
    throw new Error('Baseline Copy retry journal is corrupt');
  }
  if (
    preserved.version !== 1 ||
    preserved.orgId !== current.orgId ||
    preserved.checkpoint.category !== current.checkpoint.category ||
    preserved.checkpoint.startDay !== current.checkpoint.startDay ||
    preserved.checkpoint.endDay !== current.checkpoint.endDay ||
    preserved.checkpoint.copyAttempt !== current.checkpoint.copyAttempt ||
    preserved.checkpoint.jobId !== current.checkpoint.jobId ||
    preserved.providerJob.job_id !== current.providerJob.job_id ||
    preserved.providerJob.status !== 'error' ||
    preserved.providerJob.error !== current.providerJob.error ||
    !Number.isSafeInteger(preserved.observedAt) ||
    preserved.observedAt <= 0
  ) {
    throw new Error('Baseline Copy retry journal conflicts with preserved evidence');
  }
  return preserved;
}

function syncFile(path: string): void {
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Baseline Copy retry journal contains a non-finite number');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value !== 'object') {
    throw new Error('Baseline Copy retry journal contains an unsupported value');
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}
