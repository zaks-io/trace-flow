import { describe, expect, it } from 'vitest';
import { buildRepoLabelMap, deriveRepoLabel } from '../repoLabel';

describe('deriveRepoLabel', () => {
  it('derives owner/repo from a normalized git remote', () => {
    expect(deriveRepoLabel('github.com/acme/widgets', '', 'fp_gh')).toBe('acme/widgets');
  });

  it('strips a scheme, user, and .git suffix from the remote', () => {
    expect(deriveRepoLabel('https://github.com/acme/widgets.git', '', 'fp')).toBe('acme/widgets');
    expect(deriveRepoLabel('git@github.com:acme/widgets.git', '', 'fp')).toBe('acme/widgets');
  });

  it('falls back to a local label from the path when there is no remote', () => {
    expect(deriveRepoLabel('', '/Users/dev/projects/scratch-pad', 'fp_local')).toBe(
      'local: scratch-pad',
    );
  });

  it('falls back to a short fingerprint when neither remote nor path exists', () => {
    expect(deriveRepoLabel('', '', 'abcdef0123456789')).toBe('abcdef01');
  });

  it('prefers the remote over the path when both are present', () => {
    expect(deriveRepoLabel('github.com/acme/widgets', '/tmp/widgets', 'fp')).toBe('acme/widgets');
  });
});

describe('buildRepoLabelMap', () => {
  it('maps each fingerprint to its resolved name', () => {
    const map = buildRepoLabelMap([
      {
        repo_fingerprint: 'fp_gh',
        normalized_git_remote: 'github.com/acme/widgets',
        repo_path_fallback: '',
        repo_source: 'remote',
      },
      {
        repo_fingerprint: 'fp_local',
        normalized_git_remote: '',
        repo_path_fallback: '/x/y/proj',
        repo_source: 'path',
      },
    ]);
    expect(map.get('fp_gh')).toBe('acme/widgets');
    expect(map.get('fp_local')).toBe('local: proj');
  });
});
