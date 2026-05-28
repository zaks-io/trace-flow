import type { AgentRepoDirectoryRow } from './types';

/**
 * Resolve a repo_fingerprint to a human-readable name, client-side (the same label-join
 * pattern as the API-key map). Prefers owner/repo from the git remote, falls back to a
 * "local: <name>" label from the path, and finally a short fingerprint when neither exists.
 */
export function deriveRepoLabel(remote: string, fallback: string, fingerprint: string): string {
  const owner = ownerRepoFromRemote(remote);
  if (owner) return owner;

  const local = basename(fallback);
  if (local) return `local: ${local}`;

  return fingerprint.slice(0, 8);
}

/** Extract "owner/repo" from a normalized git remote (host stripped, .git removed). */
function ownerRepoFromRemote(remote: string): string | null {
  if (!remote) return null;
  // Drop scheme + any user@host, then split on '/' and ':' (scp-style remotes).
  const withoutScheme = remote.replace(/^[a-z]+:\/\//i, '').replace(/^[^@]+@/, '');
  const segments = withoutScheme
    .split(/[/:]/)
    .filter(Boolean)
    .map((s) => s.replace(/\.git$/i, ''));
  if (segments.length < 3) return null; // need host + owner + repo
  return segments.slice(-2).join('/');
}

function basename(path: string): string {
  if (!path) return '';
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

/** Build a Map<repo_fingerprint, display name> from the directory rows. */
export function buildRepoLabelMap(rows: AgentRepoDirectoryRow[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(
      row.repo_fingerprint,
      deriveRepoLabel(row.normalized_git_remote, row.repo_path_fallback, row.repo_fingerprint),
    );
  }
  return map;
}
