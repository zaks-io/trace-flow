import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export function syncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function executorIdentity(directory: string): string {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  syncDirectory(dirname(directory));
  const path = join(directory, 'executor.json');
  try {
    const id = JSON.parse(readFileSync(path, 'utf8')).executorId;
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id))
      throw new Error('Invalid executor identity');
    return id;
  } catch (error: any) {
    if (error.code !== 'ENOENT') throw error;
    const executorId = randomUUID();
    writeFileSync(path, JSON.stringify({ executorId }), { flag: 'wx', mode: 0o600 });
    const fd = openSync(path, 'r');
    fsyncSync(fd);
    closeSync(fd);
    syncDirectory(directory);
    return executorId;
  }
}

// Python's standard-library flock releases the lock even if this process exits without cleanup.
const LOCK = `import fcntl,os,sys
files=[]
for path in sys.argv[1:]:
    f=os.fdopen(os.open(path,os.O_CREAT|os.O_RDWR,0o600),'r+')
    try: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError: sys.exit(2)
    files.append(f)
print('locked',flush=True)
sys.stdin.read()
`;

export async function acquireExecutor(host: string, org: string, backup: string) {
  const directory = join(homedir(), '.local', 'state', 'trace-flow', 'recovery-locks');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  mkdirSync(backup, { recursive: true, mode: 0o700 });
  const key = createHash('sha256')
    .update(JSON.stringify([host, org]))
    .digest('hex');
  const process = Bun.spawn(
    ['python3', '-c', LOCK, join(directory, key), join(backup, 'executor.lock')],
    {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const reader = process.stdout.getReader();
  const first = await reader.read();
  if (first.done || new TextDecoder().decode(first.value).trim() !== 'locked') {
    process.stdin.end();
    await process.exited;
    throw new Error(
      'Another repair executor holds this organization or backup, or Python flock is unavailable',
    );
  }
  reader.releaseLock();
  return {
    assertHeld() {
      if (process.exitCode !== null) throw new Error('Repair executor lock was lost');
    },
    async release() {
      process.stdin.end();
      await process.exited;
    },
  };
}
