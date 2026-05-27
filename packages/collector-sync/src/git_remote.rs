// SPDX-License-Identifier: MIT
// Original Trace Flow code: otto-sync resolved a remote URL but never normalized one (it stored the
// raw `remote.origin.url`), so this canonicalizer has no otto equivalent. Trace Flow owns the contract,
// IDs, pricing, redaction, and storage around this code.

//! Git remote URL canonicalization.
//!
//! [`normalize_git_remote`] turns whatever `git config remote.origin.url` reports — `scp`-like,
//! `https`, `ssh://`, `git://` — into one stable `host/owner/repo` string. That string is what the
//! sync layer freezes onto a session and the ingest Worker hashes into the repo fingerprint, so two
//! clones of the same repo over different transports (SSH vs HTTPS) must collapse to the *same*
//! normalized form or they would split into two phantom repos.
//!
//! Only the host is lowercased (DNS is case-insensitive); the owner/repo path is left as git reported
//! it. An unparseable remote (no extractable host **and** path) normalizes to the empty string, which
//! downstream reads as "no remote" — the session falls back to its path label rather than fingerprinting
//! a garbage remote.

/// Canonicalize a git remote URL to `host/owner/repo` (host lowercased, `.git` suffix and surrounding
/// slashes stripped), or `""` if no host + path can be extracted. See the module docs for the rules.
pub fn normalize_git_remote(raw: &str) -> String {
    let Some((host, path)) = host_and_path(raw.trim()) else {
        return String::new();
    };
    let path = path.trim_matches('/');
    // `.git` is the suffix git appends to the whole remote, so it only ever trails the final repo
    // component; `strip_suffix` anchored to the end leaves a `.git` inside an earlier segment alone.
    let path = path.strip_suffix(".git").unwrap_or(path);
    if host.is_empty() || path.is_empty() {
        return String::new();
    }
    format!("{}/{}", host.to_ascii_lowercase(), path)
}

/// Split a remote URL into `(host, path)`. Handles `scheme://[user[:pass]@]host[:port]/path` and the
/// `scp`-like `[user@]host:path`; anything without a `/`-delimited path (a scheme URL with no path) or
/// `:`-delimited path (an scp URL) yields `None`.
fn host_and_path(remote: &str) -> Option<(&str, &str)> {
    if let Some((_scheme, rest)) = remote.split_once("://") {
        let (authority, path) = rest.split_once('/')?;
        Some((strip_userinfo_and_port(authority), path))
    } else {
        // scp-like `[user@]host:path`. Strip the `user@` *before* splitting on `:` so an embedded
        // `user:token@` (not valid scp, but seen in copied URLs) can't be mistaken for the host:path
        // colon. scp syntax has no port — a non-default port needs an `ssh://` URL — so a numeric
        // first path segment stays part of the path.
        let (host, path) = strip_userinfo(remote).split_once(':')?;
        Some((host, path))
    }
}

/// Drop `user@` and any `:port` from a scheme URL's authority, leaving the bare host.
fn strip_userinfo_and_port(authority: &str) -> &str {
    let host = strip_userinfo(authority);
    // A bracketed IPv6 host (`[2001:db8::1]`) is full of colons; keep everything through the closing
    // bracket so the port split below doesn't truncate the address to `[2001`.
    if host.starts_with('[') {
        if let Some(end) = host.find(']') {
            return &host[..=end];
        }
    }
    host.split_once(':').map_or(host, |(host, _port)| host)
}

/// Drop a leading `user@` (or `user:pass@`) from an authority, leaving everything after the last `@`.
fn strip_userinfo(authority: &str) -> &str {
    authority.rsplit_once('@').map_or(authority, |(_user, h)| h)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn equivalent_transports_collapse_to_one_form() {
        let canonical = "github.com/acme/repo";
        for raw in [
            "git@github.com:acme/repo.git",
            "https://github.com/acme/repo.git",
            "https://github.com/acme/repo",
            "ssh://git@github.com/acme/repo.git",
            "ssh://git@github.com:22/acme/repo.git",
            "git://github.com/acme/repo.git",
            "https://user:token@github.com/acme/repo.git",
        ] {
            assert_eq!(normalize_git_remote(raw), canonical, "for {raw:?}");
        }
    }

    #[test]
    fn ipv6_scheme_remote_preserves_the_full_bracketed_host() {
        // The port split must not chop a bracketed IPv6 authority at its first inner colon.
        assert_eq!(
            normalize_git_remote("ssh://git@[2001:db8::1]:2222/acme/repo.git"),
            "[2001:db8::1]/acme/repo"
        );
    }

    #[test]
    fn host_is_lowercased_but_path_case_is_preserved() {
        assert_eq!(
            normalize_git_remote("git@GitHub.com:Acme/Repo.git"),
            "github.com/Acme/Repo"
        );
    }

    #[test]
    fn multi_segment_paths_are_preserved_for_subgroups() {
        let canonical = "gitlab.com/group/subgroup/repo";
        // Both transports of a subgroup repo must still collapse together.
        assert_eq!(
            normalize_git_remote("https://gitlab.com/group/subgroup/repo.git"),
            canonical
        );
        assert_eq!(
            normalize_git_remote("git@gitlab.com:group/subgroup/repo.git"),
            canonical
        );
    }

    #[test]
    fn a_flat_single_segment_repo_path_is_kept() {
        // A self-hosted server can serve a repo at the host root; that single-segment path is a real
        // repo, not garbage, so it normalizes rather than collapsing to "".
        assert_eq!(
            normalize_git_remote("https://git.example.com/myrepo.git"),
            "git.example.com/myrepo"
        );
    }

    #[test]
    fn embedded_userinfo_in_scp_form_does_not_capture_the_host_colon() {
        // `user:token@` is not valid scp syntax, but a pasted URL might carry it; the host:path colon
        // must still be the one after the `@`, not the password colon.
        assert_eq!(
            normalize_git_remote("user:token@github.com:acme/repo.git"),
            "github.com/acme/repo"
        );
    }

    #[test]
    fn trailing_slashes_and_whitespace_are_trimmed() {
        assert_eq!(
            normalize_git_remote("  https://github.com/acme/repo/  "),
            "github.com/acme/repo"
        );
    }

    #[test]
    fn unparseable_or_pathless_remotes_normalize_to_empty() {
        for raw in [
            "",
            "   ",
            "not-a-url",
            "https://github.com",  // host but no repo path
            "https://github.com/", // empty path
            "git@github.com:",     // scp host but empty path
        ] {
            assert_eq!(normalize_git_remote(raw), "", "for {raw:?}");
        }
    }
}
