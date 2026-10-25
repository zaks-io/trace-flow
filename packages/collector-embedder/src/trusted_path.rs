// SPDX-License-Identifier: Apache-2.0
// Trace Flow Collector embedder: resolving paths that only the current user or root can redirect.

//! Resolving a path so that no other local user can decide where it leads.
//!
//! The rule is ssh's `StrictModes`, applied while resolving instead of after. The path is walked one
//! component at a time from `/` through directory handles:
//! - every directory passed through must belong to the current user or root and be writable by no
//!   one else. A sticky directory such as `/tmp` is the exception: others can add names there but
//!   cannot rename or remove yours, so the entry taken from it must belong to the current user or
//!   root.
//! - a symlink is followed only from such a directory, so only you or root could have placed it,
//!   and `..` is resolved on the filesystem after the symlinks before it, as POSIX does.
//! - missing directories, when asked for, are created `0700` inside such a directory.
//!
//! The last component is opened with `O_NOFOLLOW` once its own symlinks have been followed the same
//! way, and handed back for the caller's checks, which differ for a config file and a state dir.
//! Every check is on an open handle, and only you or root can change a trusted directory, so
//! nothing can swap a component between a check and its use.

use std::collections::VecDeque;
use std::ffi::OsString;
use std::os::unix::ffi::OsStringExt;
use std::path::{Component, Path, PathBuf};

use anyhow::{bail, Context, Result};
use rustix::fd::OwnedFd;
use rustix::fs::{AtFlags, FileType, Mode, OFlags};
use rustix::io::Errno;

/// What the last component of a path must be.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Last {
    /// Opened read-only and non-blocking, so a FIFO cannot hang the caller.
    File,
    /// Opened as a directory; with `create`, missing directories along the way are made `0700`.
    Dir { create: bool },
}

/// The kernel's own limit on symlinks in one lookup.
const MAX_SYMLINKS: usize = 40;

/// Open `path`'s last component through trusted directories, or `None` when something on the way
/// does not exist (and `last` does not ask to create it).
pub(crate) fn open(path: &Path, last: Last) -> Result<Option<OwnedFd>> {
    let absolute =
        std::path::absolute(path).with_context(|| format!("resolve {}", path.display()))?;
    let mut pending = VecDeque::new();
    push_front(&mut pending, &absolute);
    let (mut dir, mut sticky) = open_root()?;
    let mut resolved = PathBuf::from("/");
    let mut symlinks = 0;

    while let Some(name) = pending.pop_front() {
        let shown = resolved.join(&name);
        let stat = match rustix::fs::statat(&dir, name.as_os_str(), AtFlags::SYMLINK_NOFOLLOW) {
            Ok(stat) => stat,
            Err(Errno::NOENT) if last == (Last::Dir { create: true }) => {
                match rustix::fs::mkdirat(&dir, name.as_os_str(), Mode::from_raw_mode(0o700)) {
                    Ok(()) | Err(Errno::EXIST) => {}
                    Err(err) => {
                        return Err(err).with_context(|| format!("create {}", shown.display()))
                    }
                }
                pending.push_front(name);
                continue;
            }
            Err(Errno::NOENT | Errno::NOTDIR) => return missing(&shown, last),
            Err(err) => return Err(err).with_context(|| format!("stat {}", shown.display())),
        };
        if sticky && !is_trusted_owner(stat.st_uid) {
            bail!(
                "{} belongs to another user (uid {}) in a directory everyone can write to, so the \
                 path through it cannot be trusted",
                shown.display(),
                stat.st_uid
            );
        }

        if FileType::from_raw_mode(stat.st_mode) == FileType::Symlink {
            symlinks += 1;
            if symlinks > MAX_SYMLINKS {
                bail!("{} has too many levels of symlinks", path.display());
            }
            let target = rustix::fs::readlinkat(&dir, name.as_os_str(), Vec::new())
                .with_context(|| format!("read the symlink {}", shown.display()))?;
            let target = PathBuf::from(OsString::from_vec(target.into_bytes()));
            if target.is_absolute() {
                (dir, sticky) = open_root()?;
                resolved = PathBuf::from("/");
            }
            push_front(&mut pending, &target);
            continue;
        }

        let directory = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
        if pending.is_empty() {
            let flags = match last {
                Last::File => {
                    OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC
                }
                Last::Dir { .. } => directory,
            };
            let fd = rustix::fs::openat(&dir, name.as_os_str(), flags, Mode::empty())
                .with_context(|| format!("open {}", shown.display()))?;
            return Ok(Some(fd));
        }

        dir = match rustix::fs::openat(&dir, name.as_os_str(), directory, Mode::empty()) {
            Ok(next) => next,
            Err(Errno::NOENT | Errno::NOTDIR) => return missing(&shown, last),
            Err(err) => return Err(err).with_context(|| format!("open {}", shown.display())),
        };
        if name == ".." {
            resolved.pop();
        } else {
            resolved = shown;
        }
        sticky = ensure_trusted_dir(&dir, &resolved)?;
    }

    match last {
        Last::Dir { .. } => Ok(Some(dir)),
        Last::File => bail!("{} is not a regular file", path.display()),
    }
}

/// Nothing to open is an answer for a reader, but a directory that was to be created must exist.
fn missing(shown: &Path, last: Last) -> Result<Option<OwnedFd>> {
    if last == (Last::Dir { create: true }) {
        bail!("{} is not a directory", shown.display());
    }
    Ok(None)
}

/// The current user, or root, who already controls everything the current user can do.
pub(crate) fn is_trusted_owner(uid: u32) -> bool {
    uid == 0 || uid == rustix::process::geteuid().as_raw()
}

fn open_root() -> Result<(OwnedFd, bool)> {
    let flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC;
    let root = rustix::fs::open("/", flags, Mode::empty()).context("open /")?;
    let sticky = ensure_trusted_dir(&root, Path::new("/"))?;
    Ok((root, sticky))
}

fn push_front(pending: &mut VecDeque<OsString>, path: &Path) {
    let names: Vec<OsString> = path
        .components()
        .filter_map(|component| match component {
            Component::Normal(name) => Some(name.to_os_string()),
            Component::ParentDir => Some(OsString::from("..")),
            Component::RootDir | Component::CurDir | Component::Prefix(_) => None,
        })
        .collect();
    for name in names.into_iter().rev() {
        pending.push_front(name);
    }
}

/// Fails unless the current user or root owns `dir` and no one else can write to it, except in a
/// sticky directory. Returns whether it is one of those, whose entries need their own owner check.
fn ensure_trusted_dir(dir: &OwnedFd, shown: &Path) -> Result<bool> {
    let stat = rustix::fs::fstat(dir).with_context(|| format!("stat {}", shown.display()))?;
    #[allow(clippy::useless_conversion, reason = "st_mode is u16 on macOS")]
    let mode = u32::from(stat.st_mode) & 0o7777;
    if !is_trusted_owner(stat.st_uid) {
        bail!(
            "{} belongs to another user (uid {}), so the path through it cannot be trusted",
            shown.display(),
            stat.st_uid
        );
    }
    if mode & 0o022 == 0 {
        return Ok(false);
    }
    if mode & 0o1000 != 0 {
        return Ok(true);
    }
    bail!(
        "{} is writable by other users (mode {:o}), so the path through it cannot be trusted; \
         check that what it holds is yours and as you left it, then run `chmod go-w` on it",
        shown.display(),
        mode & 0o777
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    fn mode(path: &Path) -> u32 {
        fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn missing_directories_are_created_private() {
        let root = crate::test_support::private_tempdir();
        let dir = root.path().join("a/b");
        assert!(open(&dir, Last::Dir { create: false }).unwrap().is_none());
        assert!(!root.path().join("a").exists(), "only `create` creates");

        assert!(open(&dir, Last::Dir { create: true }).unwrap().is_some());
        assert_eq!(mode(&root.path().join("a")), 0o700);
        assert_eq!(mode(&dir), 0o700);
    }

    #[test]
    fn nothing_is_created_under_a_directory_others_can_write_to() {
        let root = crate::test_support::private_tempdir();
        let shared = root.path().join("shared");
        fs::create_dir(&shared).unwrap();
        fs::set_permissions(&shared, fs::Permissions::from_mode(0o775)).unwrap();

        let err = open(&shared.join("state"), Last::Dir { create: true })
            .unwrap_err()
            .to_string();
        assert!(err.contains("writable by other users"), "{err}");
        assert!(!shared.join("state").exists());
    }
}
