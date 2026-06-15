/**
 * Smoke test: pipe-file JWT guards run via scripts/verify-tinybird-jwt-allowlist.ts
 * (outside packages/convex — safe for Convex preview deploy).
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

const REPO_ROOT = join(__dirname, '..');
const VERIFY_SCRIPT = join(REPO_ROOT, 'scripts/verify-tinybird-jwt-allowlist.ts');

describe('Tinybird JWT mintable pipe inventory', () => {
  it('passes the Node-only allowlist verification script', () => {
    const output = execFileSync('bun', [VERIFY_SCRIPT], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(output).toMatch(/Tinybird JWT allowlist OK/);
  });
});
